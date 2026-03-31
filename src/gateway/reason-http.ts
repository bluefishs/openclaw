/**
 * CK Agent Communication Schema v1.0 — /reason endpoint handler
 *
 * Provides a standardized reasoning endpoint for CK_ projects to invoke
 * OpenClaw's agent capabilities via a unified JSON schema.
 *
 * Authentication: dual-mode (X-Service-Token priority, Bearer token fallback)
 * Rate limiting: sliding window per agent_id (default 60 req/min)
 * Tool routing: payload.tool → internal /tools/invoke bridge
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import type { ConversationMemoryService } from "../memory/conversation-memory.js";
import { defaultRuntime } from "../runtime.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { getCorrelationId } from "./correlation.js";
import {
  readJsonBodyOrError,
  safeTokenEqual,
  sendJson,
  sendMethodNotAllowed,
  setSseHeaders,
  writeDone,
} from "./http-common.js";
import { getBearerToken, getHeader } from "./http-utils.js";
import { orchestrate, type LeaderAgentResult } from "./leader-agent.js";
import { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";

type ReasonHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  /** Injected conversation memory service (optional — stateless if absent) */
  memory?: ConversationMemoryService;
};

type ReasonRequestPayload = {
  question?: string;
  tool?: string;
  args?: Record<string, unknown>;
  context?: Record<string, unknown>;
};

type ReasonRequestBody = {
  agent_id?: string;
  action?: string;
  payload?: ReasonRequestPayload;
  options?: {
    stream?: boolean;
    timeout_ms?: number;
    priority?: string;
  };
  session_id?: string;
  timestamp?: string;
};

// ─── Rate Limiting (sliding window per agent_id + global IP backstop) ───

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 60; // 60 req/min per agent_id
const RATE_LIMIT_MAX_ENTRIES = 10_000; // Cap map size to prevent memory exhaustion
const RATE_LIMIT_IP_MAX_REQUESTS = 300; // 300 req/min per source IP (global backstop)

type RateLimitEntry = {
  timestamps: number[];
};

const rateLimitMap = new Map<string, RateLimitEntry>();

// Periodic cleanup of stale entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (entry.timestamps.length === 0) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60_000).unref();

function checkRateLimit(
  agentId: string,
  clientIp?: string,
): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();

  // Global IP backstop: prevent rotating agent_ids to bypass per-agent limits
  if (clientIp) {
    const ipKey = `__ip:${clientIp}`;
    let ipEntry = rateLimitMap.get(ipKey);
    if (!ipEntry) {
      // Don't create IP entry if map is full (IP entries share the same map)
      if (rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES) {
        return { allowed: false, retryAfterMs: RATE_LIMIT_WINDOW_MS };
      }
      ipEntry = { timestamps: [] };
      rateLimitMap.set(ipKey, ipEntry);
    }
    ipEntry.timestamps = ipEntry.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (ipEntry.timestamps.length >= RATE_LIMIT_IP_MAX_REQUESTS) {
      const oldest = ipEntry.timestamps[0];
      return { allowed: false, retryAfterMs: RATE_LIMIT_WINDOW_MS - (now - oldest) };
    }
    ipEntry.timestamps.push(now);
  }

  // Per-agent_id limit
  let entry = rateLimitMap.get(agentId);
  if (!entry) {
    // Reject unknown agent_ids when map is at capacity (prevents memory exhaustion)
    if (rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES) {
      return { allowed: false, retryAfterMs: RATE_LIMIT_WINDOW_MS };
    }
    entry = { timestamps: [] };
    rateLimitMap.set(agentId, entry);
  }

  // Remove timestamps outside the window
  entry.timestamps = entry.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (entry.timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    const oldestInWindow = entry.timestamps[0];
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - oldestInWindow);
    return { allowed: false, retryAfterMs };
  }

  entry.timestamps.push(now);
  return { allowed: true };
}

function sendRateLimited(res: ServerResponse, retryAfterMs: number) {
  const retryAfterS = Math.ceil(retryAfterMs / 1000);
  res.setHeader("Retry-After", String(retryAfterS));
  sendJson(res, 429, {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: `Rate limit exceeded. Retry after ${retryAfterS} seconds.`,
      details: { retry_after_ms: retryAfterMs },
    },
    timestamp: new Date().toISOString(),
  });
}

// ─── Body parsing ───

function coerceBody(val: unknown): ReasonRequestBody {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as ReasonRequestBody;
}

// safeTokenEqual imported from ./http-common.js (SHA-256 constant-time comparison)

function sendSchemaError(res: ServerResponse, message: string) {
  sendJson(res, 400, {
    success: false,
    error: { code: "INVALID_SCHEMA", message },
    timestamp: new Date().toISOString(),
  });
}

function sendAuthFailed(res: ServerResponse, message: string) {
  sendJson(res, 401, {
    success: false,
    error: { code: "AUTH_FAILED", message },
    timestamp: new Date().toISOString(),
  });
}

/** Write a named SSE event with JSON data */
function writeSseEvent(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Dual-mode authentication:
 * 1. X-Service-Token (for CK_ cross-service calls)
 * 2. Fallback to OpenClaw native auth (Bearer / Password / Tailscale / Loopback)
 */
async function authenticateRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ReasonHttpOptions,
): Promise<boolean> {
  const serviceToken = getHeader(req, "x-service-token");
  const expectedToken = process.env.MCP_SERVICE_TOKEN;

  if (serviceToken) {
    if (expectedToken && safeTokenEqual(serviceToken, expectedToken)) {
      return true;
    }
    sendAuthFailed(res, "Invalid service token");
    return false;
  }

  // Fallback to OpenClaw native auth
  const token = getBearerToken(req);
  const authResult = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: { token, password: token },
    req,
    trustedProxies: opts.trustedProxies,
  });
  if (!authResult.ok) {
    sendAuthFailed(res, authResult.reason ?? "Unauthorized");
    return false;
  }
  return true;
}

export async function handleReasonHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ReasonHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

  // ── Health / observability endpoint (GET /reason/health) ──
  if (url.pathname === "/reason/health") {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }
    // Requires authentication (service token or native auth)
    const authOk = await authenticateRequest(req, res, opts);
    if (!authOk) {
      return true;
    }

    const memory = opts.memory;
    if (!memory) {
      sendJson(res, 200, {
        status: "stateless",
        memory: null,
        timestamp: new Date().toISOString(),
      });
      return true;
    }
    const stats = await memory.getStats();
    sendJson(res, 200, {
      status: stats.healthy ? "ok" : "degraded",
      memory: stats,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  if (url.pathname !== "/reason") {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  // Authentication
  const authenticated = await authenticateRequest(req, res, opts);
  if (!authenticated) {
    return true;
  }

  // Parse body
  const rawBody = await readJsonBodyOrError(req, res, opts.maxBodyBytes ?? 1024 * 1024);
  if (rawBody === undefined) {
    return true;
  }

  const body = coerceBody(rawBody);

  // Validate required fields
  if (!body.agent_id || typeof body.agent_id !== "string") {
    sendSchemaError(res, "Missing or invalid `agent_id`");
    return true;
  }
  if (body.agent_id.length > 128) {
    sendSchemaError(res, "`agent_id` exceeds maximum length (128 chars)");
    return true;
  }
  if (
    body.session_id != null &&
    typeof body.session_id === "string" &&
    body.session_id.length > 256
  ) {
    sendSchemaError(res, "`session_id` exceeds maximum length (256 chars)");
    return true;
  }
  if (!body.payload || typeof body.payload !== "object") {
    sendSchemaError(res, "Missing or invalid `payload`");
    return true;
  }

  // Rate limiting (per agent_id + global IP backstop)
  const clientIp = req.socket.remoteAddress;
  const rateCheck = checkRateLimit(body.agent_id, clientIp);
  if (!rateCheck.allowed) {
    sendRateLimited(res, rateCheck.retryAfterMs!);
    return true;
  }

  const payload = body.payload;
  const question = typeof payload.question === "string" ? payload.question.trim() : "";
  const tool = typeof payload.tool === "string" ? payload.tool.trim() : "";

  if (!question && !tool) {
    sendSchemaError(res, "`payload` must contain `question` or `tool`");
    return true;
  }

  const MAX_QUESTION_LENGTH = 32_000;
  if (question.length > MAX_QUESTION_LENGTH) {
    sendSchemaError(res, `\`question\` exceeds maximum length (${MAX_QUESTION_LENGTH} chars)`);
    return true;
  }

  const correlationId = getCorrelationId(req);
  const requestId = `reason_${randomUUID()}`;
  const startMs = Date.now();

  // Route: question → agentCommand (with conversation memory)
  if (question) {
    const hasSessionId = !!body.session_id;
    const sessionId = body.session_id || randomUUID();
    const memory = opts.memory; // DI — undefined if stateless mode
    const isStream = body.options?.stream === true;

    try {
      // ── 1. Load conversation history (graceful: empty if no memory or no session) ──
      const memKey = memory && hasSessionId ? memory.buildKey(body.agent_id, sessionId) : null;
      const history = memKey ? await memory!.loadContext(memKey) : [];
      const historyPrompt = memory ? memory.formatForPrompt(history) : "";

      // ── 2. Assemble enhanced system prompt (history + caller context) ──
      const contextParts: string[] = [];
      if (historyPrompt) {
        contextParts.push(historyPrompt);
      }
      if (payload.context) {
        contextParts.push(`Context from ${body.agent_id}: ${JSON.stringify(payload.context)}`);
      }
      const extraSystemPrompt = contextParts.length > 0 ? contextParts.join("\n\n") : undefined;

      // ── SSE mode: send progress events to prevent timeout ──
      if (isStream) {
        setSseHeaders(res);
        writeSseEvent(res, "start", {
          request_id: requestId,
          correlation_id: correlationId,
          agent_id: body.agent_id,
          timestamp: new Date().toISOString(),
        });
      }

      // ── 2.5. Leader Agent: detect multi-domain intent → fan-out/fan-in ──
      let leaderResult: LeaderAgentResult | null = null;
      const serviceToken = process.env.MCP_SERVICE_TOKEN;
      if (serviceToken) {
        leaderResult = await orchestrate(question, {
          serviceToken,
          correlationId: correlationId ?? undefined,
        });

        if (isStream && leaderResult.orchestrated) {
          writeSseEvent(res, "orchestrating", {
            sub_tasks: leaderResult.subResults.length,
            agents: leaderResult.subResults.map((r) => r.agentId),
          });
        }
      }

      // ── 3. Invoke LLM reasoning ──
      // If Leader Agent produced a synthesis prompt, use it as the message
      const llmMessage = leaderResult?.synthesisPrompt ?? question;
      const sessionKey = `reason:${body.agent_id}:${sessionId}`;
      const deps = createDefaultDeps();
      const result = await agentCommand(
        {
          message: llmMessage,
          extraSystemPrompt,
          sessionKey,
          runId: requestId,
          deliver: false,
          messageChannel: "api",
          bestEffortDeliver: false,
        },
        defaultRuntime,
        deps,
      );

      const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
      const answer =
        Array.isArray(payloads) && payloads.length > 0
          ? payloads
              .map((p) => (typeof p.text === "string" ? p.text : ""))
              .filter(Boolean)
              .join("\n\n")
          : "";

      // ── 4. Save turn to memory (fire-and-forget, non-blocking) ──
      if (memKey && answer) {
        // Save original question (not synthesis prompt) for user-facing history
        memory!.saveTurn(memKey, question, answer).catch((err) => {
          console.warn(`[reason] saveTurn failed: ${String(err)}`);
        });
      }

      const latencyMs = Date.now() - startMs;

      const responseMeta: Record<string, unknown> = {
        latency_ms: latencyMs,
        request_id: requestId,
        correlation_id: correlationId,
        ...(hasSessionId && {
          conversation: {
            session_id: sessionId,
            history_turns: Math.floor(history.length / 2),
          },
        }),
        // Include orchestration details if Leader Agent was used
        ...(leaderResult?.orchestrated && {
          orchestration: {
            orchestrated: true,
            sub_results: leaderResult.subResults.map((r) => ({
              agent_id: r.agentId,
              agent_name: r.agentName,
              success: r.success,
              latency_ms: r.latencyMs,
              ...(r.error && { error: r.error }),
            })),
            fan_out_latency_ms: leaderResult.totalLatencyMs,
          },
        }),
      };

      const responsePayload = {
        success: true,
        agent_id: "openclaw",
        action: body.action ?? "reason",
        result: {
          answer,
          sources: [],
          tools_used: [],
          model: "openclaw",
        },
        meta: responseMeta,
        timestamp: new Date().toISOString(),
      };

      if (isStream) {
        writeSseEvent(res, "delta", responsePayload);
        writeDone(res);
        res.end();
      } else {
        sendJson(res, 200, responsePayload);
      }
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      // Log full error server-side; send generic message to client
      console.error(`[reason] request ${requestId} corr=${correlationId} failed:`, err);

      const errorPayload = {
        success: false,
        agent_id: "openclaw",
        action: body.action ?? "reason",
        result: null,
        error: {
          code: "INTERNAL_ERROR",
          message: "An internal error occurred while processing the request",
        },
        meta: {
          latency_ms: latencyMs,
          request_id: requestId,
          correlation_id: correlationId,
        },
        timestamp: new Date().toISOString(),
      };

      if (isStream) {
        // If SSE headers already sent, write error as event
        writeSseEvent(res, "error", errorPayload);
        writeDone(res);
        res.end();
      } else {
        sendJson(res, 500, errorPayload);
      }
    }
    return true;
  }

  // Route: tool → bridge to /tools/invoke
  if (tool) {
    try {
      const toolArgs: Record<string, unknown> =
        payload.args && typeof payload.args === "object" ? payload.args : {};

      // Construct an internal request to /tools/invoke
      const toolBody = {
        tool,
        args: toolArgs,
        sessionKey: body.session_id
          ? `reason:${body.agent_id}:${body.session_id}`
          : `reason:${body.agent_id}:${randomUUID()}`,
      };

      // Create a synthetic request targeting /tools/invoke
      const syntheticReq = Object.create(req) as IncomingMessage;
      const originalUrl = req.url;
      syntheticReq.url = "/tools/invoke";
      syntheticReq.method = "POST";

      // Buffer the tool body so readJsonBodyOrError can parse it
      const toolBodyBuf = Buffer.from(JSON.stringify(toolBody));
      let bodyRead = false;
      syntheticReq.on = ((event: string, handler: (...args: unknown[]) => void) => {
        if (event === "data" && !bodyRead) {
          bodyRead = true;
          handler(toolBodyBuf);
        }
        if (event === "end") {
          handler();
        }
        return syntheticReq;
      }) as typeof syntheticReq.on;

      // Capture the /tools/invoke response
      const toolHandled = await handleToolsInvokeHttpRequest(syntheticReq, res, {
        auth: opts.auth,
        trustedProxies: opts.trustedProxies,
      });

      // Restore original URL
      req.url = originalUrl;

      if (toolHandled) {
        return true;
      }

      // If /tools/invoke didn't handle it, fall back to error
      const latencyMs = Date.now() - startMs;
      sendJson(res, 400, {
        success: false,
        agent_id: "openclaw",
        action: body.action ?? "reason",
        result: null,
        error: {
          code: "INVALID_SCHEMA",
          message: `Tool "${tool}" not found or not available`,
        },
        meta: { latency_ms: latencyMs, request_id: requestId, correlation_id: correlationId },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      console.error(`[reason] tool invocation ${requestId} corr=${correlationId} failed:`, err);
      sendJson(res, 500, {
        success: false,
        agent_id: "openclaw",
        action: body.action ?? "reason",
        result: null,
        error: {
          code: "INTERNAL_ERROR",
          message: "An internal error occurred while invoking the tool",
        },
        meta: { latency_ms: latencyMs, request_id: requestId, correlation_id: correlationId },
        timestamp: new Date().toISOString(),
      });
    }
    return true;
  }

  sendSchemaError(res, "`payload` must contain `question` or `tool`");
  return true;
}
