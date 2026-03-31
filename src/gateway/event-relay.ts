/**
 * EventRelay — Redis Pub/Sub → SSE bridge for real-time event push
 *
 * Provides a GET /events SSE endpoint that clients (NemoClaw, CK_ plugins, frontends)
 * can subscribe to for real-time notifications (job completion, agent responses, etc.).
 *
 * Architecture:
 *   Publisher: Any service calls `relay.publish(channel, event)` → Redis PUBLISH
 *   Subscriber: GET /events?channel=xxx → SSE stream ← Redis SUBSCRIBE
 *
 * Channel convention: ck:events:{scope}
 *   e.g., ck:events:jobs, ck:events:agents, ck:events:all
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import Redis from "ioredis";
import { getCorrelationId } from "./correlation.js";
import { safeTokenEqual, setSseHeaders } from "./http-common.js";
import { getHeader } from "./http-utils.js";

// ─── Types ───

export type RelayEvent = {
  type: string;
  payload: unknown;
  correlation_id?: string;
  timestamp: string;
};

export type EventRelayConfig = {
  /** Channel prefix (default: "ck:events") */
  channelPrefix: string;
  /** Max concurrent SSE connections (default: 100) */
  maxConnections: number;
  /** Heartbeat interval in ms to keep SSE alive (default: 30000) */
  heartbeatMs: number;
};

const DEFAULT_CONFIG: EventRelayConfig = {
  channelPrefix: "ck:events",
  maxConnections: 100,
  heartbeatMs: 30_000,
};

// ─── Allowed channels (whitelist to prevent arbitrary subscription) ───

const ALLOWED_CHANNELS = new Set(["jobs", "agents", "collab", "workflow", "all"]);

/** Validate and sanitize channel name */
function resolveChannel(raw: string | undefined, prefix: string): string | null {
  const name = raw?.trim();
  if (!name || !ALLOWED_CHANNELS.has(name)) {
    return null;
  }
  return `${prefix}:${name}`;
}

// ─── Service ───

/** Ticket TTL in ms (default 30 seconds) */
const TICKET_TTL_MS = 30_000;
/** Max pending tickets to prevent memory exhaustion */
const MAX_PENDING_TICKETS = 200;
/** Max ticket requests per TICKET_RATE_WINDOW_MS */
const TICKET_RATE_LIMIT = 10;
/** Rate limit window in ms */
const TICKET_RATE_WINDOW_MS = 10_000;
/** Max distinct IPs tracked in ticketRequestTimes to prevent memory exhaustion */
const MAX_TRACKED_IPS = 1_000;
/** Max SSE connections per channel */
const MAX_CONNECTIONS_PER_CHANNEL = 50;

export class EventRelayService {
  /** Dedicated Redis connection for PUBLISH (shares main connection) */
  private pubRedis: Redis;
  /** Dedicated Redis connection for SUBSCRIBE (ioredis requires separate client) */
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  private subRedis: Redis | null = null;
  private config: EventRelayConfig;
  private ready = false;
  private connections = new Set<ServerResponse>();
  /** Map channel → Set of SSE response objects */
  private channelSubs = new Map<string, Set<ServerResponse>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** One-time SSE tickets: ticket → expiry timestamp */
  private tickets = new Map<string, number>();
  /** Per-IP sliding window timestamps for ticket rate limiting */
  private ticketRequestTimes = new Map<string, number[]>();

  constructor(pubRedis: Redis, config?: Partial<EventRelayConfig>) {
    this.pubRedis = pubRedis;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Issue a one-time ticket for SSE connection.
   * The caller must already be authenticated (e.g., via X-Service-Token).
   * Returns a 32-byte hex string valid for TICKET_TTL_MS.
   */
  issueTicket(): string {
    const now = Date.now();
    // Always evict expired tickets (cheap O(n) scan, n <= MAX_PENDING_TICKETS)
    for (const [t, exp] of this.tickets) {
      if (exp <= now) {
        this.tickets.delete(t);
      }
    }
    if (this.tickets.size >= MAX_PENDING_TICKETS) {
      throw new Error("Too many pending SSE tickets");
    }
    const ticket = randomBytes(32).toString("hex");
    this.tickets.set(ticket, now + TICKET_TTL_MS);
    return ticket;
  }

  /** Consume a ticket — returns true if valid and not expired, and deletes it. Always deletes to prevent reuse. */
  private consumeTicket(ticket: string): boolean {
    const expiry = this.tickets.get(ticket);
    if (expiry == null) {
      return false;
    }
    // Always delete first to prevent race-condition reuse, then check expiry
    this.tickets.delete(ticket);
    if (Date.now() >= expiry) {
      return false;
    }
    return true;
  }

  /**
   * Handle POST /events/ticket — exchange service token for a one-time SSE ticket.
   * Returns true if handled, false if not a ticket request.
   */
  handleTicketRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/events/ticket") {
      return false;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const expectedToken = process.env.MCP_SERVICE_TOKEN;
    if (expectedToken) {
      const headerToken = getHeader(req, "x-service-token");
      if (!headerToken || !safeTokenEqual(headerToken, expectedToken)) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Unauthorized");
        return true;
      }
    }

    // Per-IP rate limit: sliding window
    const now = Date.now();
    const clientIp =
      getHeader(req, "x-forwarded-for")?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";
    const cutoff = now - TICKET_RATE_WINDOW_MS;
    let ipTimes = this.ticketRequestTimes.get(clientIp);
    if (ipTimes) {
      // Evict stale entries from this IP
      while (ipTimes.length > 0 && ipTimes[0] <= cutoff) {
        ipTimes.shift();
      }
      // Prune empty IP entries to prevent Map key leak from many distinct IPs
      if (ipTimes.length === 0) {
        this.ticketRequestTimes.delete(clientIp);
        ipTimes = undefined;
      }
    }
    if (ipTimes && ipTimes.length >= TICKET_RATE_LIMIT) {
      res.statusCode = 429;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Retry-After", String(Math.ceil(TICKET_RATE_WINDOW_MS / 1000)));
      res.end("Too Many Requests");
      return true;
    }
    if (!ipTimes) {
      // Prevent unbounded growth from many distinct (possibly spoofed) IPs
      if (this.ticketRequestTimes.size >= MAX_TRACKED_IPS) {
        // Evict all empty entries first
        for (const [ip, times] of this.ticketRequestTimes) {
          if (times.length === 0) {
            this.ticketRequestTimes.delete(ip);
          }
        }
        // If still over limit, reject — don't allocate new entries
        if (this.ticketRequestTimes.size >= MAX_TRACKED_IPS) {
          res.statusCode = 503;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Service temporarily unavailable");
          return true;
        }
      }
      ipTimes = [];
      this.ticketRequestTimes.set(clientIp, ipTimes);
    }
    ipTimes.push(now);

    const ticket = this.issueTicket();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ticket, expires_in_ms: TICKET_TTL_MS }));
    return true;
  }

  /** Remove a connection from both connections set and all channelSubs. */
  private removeConnection(res: ServerResponse): void {
    this.connections.delete(res);
    for (const subs of this.channelSubs.values()) {
      subs.delete(res);
    }
  }

  /**
   * Initialize subscriber connection and start listening.
   * Must be called after Redis is connected.
   */
  async start(subRedis: Redis): Promise<void> {
    this.subRedis = subRedis;

    if (!process.env.MCP_SERVICE_TOKEN) {
      console.warn(
        "[event-relay] MCP_SERVICE_TOKEN is not set — SSE /events endpoint will be unauthenticated. " +
          "Set MCP_SERVICE_TOKEN to enable authentication.",
      );
    }

    subRedis.on("message", (channel: string, message: string) => {
      const subs = this.channelSubs.get(channel);
      if (!subs || subs.size === 0) {
        return;
      }

      // Fan-out to all SSE connections subscribed to this channel
      for (const res of subs) {
        try {
          res.write(`event: message\ndata: ${message}\n\n`);
        } catch {
          // Client disconnected — clean up from all structures
          this.removeConnection(res);
        }
      }
    });

    // Heartbeat to keep connections alive through proxies
    this.heartbeatTimer = setInterval(() => {
      for (const res of this.connections) {
        try {
          res.write(`:heartbeat\n\n`);
        } catch {
          this.removeConnection(res);
        }
      }
    }, this.config.heartbeatMs);
    this.heartbeatTimer.unref();

    this.ready = true;
  }

  /**
   * Publish an event to a channel.
   * Automatically fans out to the "all" channel so publishers don't need to
   * double-publish. Can be called from any handler (e.g., task tracker on job completion).
   */
  async publish(channelName: string, event: RelayEvent): Promise<void> {
    if (!this.ready) {
      return;
    }
    if (!ALLOWED_CHANNELS.has(channelName)) {
      console.warn(
        `[event-relay] Publishing to non-whitelisted channel "${channelName}" — subscribers cannot receive it`,
      );
    }
    const data = JSON.stringify(event);
    const channel = `${this.config.channelPrefix}:${channelName}`;
    try {
      await this.pubRedis.publish(channel, data);
    } catch (err) {
      console.warn(`[event-relay] publish failed: ${String(err)}`);
    }
    // Auto fan-out to "all" channel for dashboard consumers
    if (channelName !== "all") {
      const allChannel = `${this.config.channelPrefix}:all`;
      try {
        await this.pubRedis.publish(allChannel, data);
      } catch {
        // Best-effort — primary publish already succeeded
      }
    }
  }

  /**
   * Handle GET /events?channel=xxx SSE subscription.
   * Returns true if handled, false if not an /events request.
   */
  async handleSseRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/events") {
      return false;
    }

    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    // Authentication: X-Service-Token header, one-time ?ticket=, or legacy ?token=
    // Prefer ticket exchange (POST /events/ticket → GET /events?ticket=xxx) to
    // avoid long-lived tokens in URL/server logs.
    const expectedToken = process.env.MCP_SERVICE_TOKEN;
    if (expectedToken) {
      const headerToken = getHeader(req, "x-service-token");
      const ticketParam = url.searchParams.get("ticket");
      const queryToken = url.searchParams.get("token"); // legacy fallback

      let authenticated = false;
      if (headerToken && safeTokenEqual(headerToken, expectedToken)) {
        authenticated = true;
      } else if (ticketParam && this.consumeTicket(ticketParam)) {
        authenticated = true;
      } else if (queryToken && safeTokenEqual(queryToken, expectedToken)) {
        authenticated = true;
      }

      if (!authenticated) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Unauthorized");
        return true;
      }
    }

    if (!this.ready || !this.subRedis) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Event relay not available");
      return true;
    }

    // Connection limit
    if (this.connections.size >= this.config.maxConnections) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Too many event connections");
      return true;
    }

    const channelName = url.searchParams.get("channel") ?? "all";
    const fullChannel = resolveChannel(channelName, this.config.channelPrefix);
    if (!fullChannel) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`Invalid channel. Allowed: ${[...ALLOWED_CHANNELS].join(", ")}`);
      return true;
    }

    // Per-channel connection limit
    const existingSubs = this.channelSubs.get(fullChannel);
    if (existingSubs && existingSubs.size >= MAX_CONNECTIONS_PER_CHANNEL) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`Too many connections on channel "${channelName}"`);
      return true;
    }

    // Set up SSE
    setSseHeaders(res);
    this.connections.add(res);

    // Subscribe to Redis channel (idempotent for already-subscribed channels)
    let subs = existingSubs;
    if (!subs) {
      subs = new Set();
      this.channelSubs.set(fullChannel, subs);
      await this.subRedis.subscribe(fullChannel);
    }
    subs.add(res);

    const correlationId = getCorrelationId(req);

    // Send initial connected event
    const connectEvent: RelayEvent = {
      type: "connected",
      payload: { channel: channelName, correlation_id: correlationId },
      timestamp: new Date().toISOString(),
    };
    res.write(`event: connected\ndata: ${JSON.stringify(connectEvent)}\n\n`);

    // Cleanup on disconnect
    const cleanup = () => {
      this.connections.delete(res);
      const chanSubs = this.channelSubs.get(fullChannel);
      if (chanSubs) {
        chanSubs.delete(res);
        // Unsubscribe from Redis if no more listeners
        if (chanSubs.size === 0) {
          this.channelSubs.delete(fullChannel);
          this.subRedis?.unsubscribe(fullChannel).catch(() => {});
        }
      }
    };

    req.on("close", cleanup);
    req.on("error", cleanup);

    return true;
  }

  /**
   * Graceful shutdown: close all SSE connections and clean up.
   */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Close all SSE connections
    for (const res of this.connections) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
    this.channelSubs.clear();
    this.tickets.clear();
    this.ticketRequestTimes.clear();

    // Unsubscribe all
    if (this.subRedis) {
      try {
        await this.subRedis.unsubscribe();
      } catch {
        /* ignore */
      }
    }

    this.ready = false;
  }

  /**
   * Observability stats.
   */
  getStats(): {
    ready: boolean;
    activeConnections: number;
    maxConnections: number;
    subscribedChannels: number;
  } {
    return {
      ready: this.ready,
      activeConnections: this.connections.size,
      maxConnections: this.config.maxConnections,
      subscribedChannels: this.channelSubs.size,
    };
  }
}
