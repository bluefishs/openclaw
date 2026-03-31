import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventRelayService, type RelayEvent } from "./event-relay.js";

// ─── Mock Redis ───

interface MockSubRedis {
  on: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  _handlers: Map<string, (...args: unknown[]) => void>;
  _emit: (event: string, ...args: unknown[]) => void;
}

function createMockPubRedis() {
  return {
    publish: vi.fn(async () => 1),
  };
}

function createMockSubRedis(): MockSubRedis {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    _handlers: handlers,
    _emit(event: string, ...args: unknown[]) {
      const h = handlers.get(event);
      if (h) {
        h(...args);
      }
    },
  };
}

function createMockReq(url: string, method = "GET"): IncomingMessage {
  const handlers = new Map<string, () => void>();
  return {
    url,
    method,
    headers: { host: "localhost" },
    on: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler);
    }),
    _triggerEvent(event: string) {
      const h = handlers.get(event);
      if (h) {
        h();
      }
    },
  } as unknown as IncomingMessage & { _triggerEvent: (event: string) => void };
}

function createMockRes(): ServerResponse & { _written: string[]; _ended: boolean } {
  const _written: string[] = [];
  let _ended = false;
  return {
    _written,
    _ended,
    statusCode: 200,
    write: vi.fn((data: string) => {
      _written.push(data);
      return true;
    }),
    end: vi.fn((data?: string) => {
      if (data) {
        _written.push(data);
      }
      _ended = true;
    }),
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
  } as unknown as ServerResponse & { _written: string[]; _ended: boolean };
}

describe("EventRelayService", () => {
  let pubRedis: ReturnType<typeof createMockPubRedis>;
  let subRedis: ReturnType<typeof createMockSubRedis>;
  let relay: EventRelayService;

  beforeEach(async () => {
    pubRedis = createMockPubRedis();
    subRedis = createMockSubRedis();
    relay = new EventRelayService(pubRedis as never, { maxConnections: 3, heartbeatMs: 60_000 });
    await relay.start(subRedis as never);
  });

  afterEach(async () => {
    await relay.stop();
  });

  describe("publish", () => {
    it("publishes event to Redis channel with prefix", async () => {
      const event: RelayEvent = {
        type: "job_completed",
        payload: { job_id: "j-1" },
        timestamp: new Date().toISOString(),
      };
      await relay.publish("jobs", event);
      expect(pubRedis.publish).toHaveBeenCalledWith("ck:events:jobs", JSON.stringify(event));
    });

    it("auto fans out to 'all' channel", async () => {
      const event: RelayEvent = {
        type: "workflow_started",
        payload: { workflow_id: "wf-1" },
        timestamp: new Date().toISOString(),
      };
      await relay.publish("workflow", event);
      const calls = (pubRedis.publish as ReturnType<typeof vi.fn>).mock.calls;
      // Should publish to both the specific channel and "all"
      expect(calls).toHaveLength(2);
      expect(calls[0][0]).toBe("ck:events:workflow");
      expect(calls[1][0]).toBe("ck:events:all");
      // Both should have the same event data
      expect(calls[0][1]).toBe(calls[1][1]);
    });

    it("does not double-publish when channel is 'all'", async () => {
      const event: RelayEvent = {
        type: "broadcast",
        payload: {},
        timestamp: new Date().toISOString(),
      };
      await relay.publish("all", event);
      const calls = (pubRedis.publish as ReturnType<typeof vi.fn>).mock.calls;
      // Should only publish once (no fan-out to "all" since it already IS "all")
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe("ck:events:all");
    });

    it("no-ops when not ready", async () => {
      await relay.stop();
      await relay.publish("jobs", { type: "test", payload: {}, timestamp: "" });
      // publish was called before stop, so only check it wasn't called after stop
      expect((pubRedis.publish as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });
  });

  describe("handleSseRequest", () => {
    it("returns false for non-/events paths", async () => {
      const req = createMockReq("/reason");
      const res = createMockRes();
      const handled = await relay.handleSseRequest(req, res);
      expect(handled).toBe(false);
    });

    it("rejects non-GET methods", async () => {
      const req = createMockReq("/events", "POST");
      const res = createMockRes();
      const handled = await relay.handleSseRequest(req, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(405);
    });

    it("rejects invalid channel names", async () => {
      const req = createMockReq("/events?channel=evil_injection");
      const res = createMockRes();
      const handled = await relay.handleSseRequest(req, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
    });

    it("accepts valid channel and sends connected event", async () => {
      const req = createMockReq("/events?channel=jobs");
      const res = createMockRes();
      const handled = await relay.handleSseRequest(req, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/event-stream; charset=utf-8",
      );

      // Should have written a connected event
      const written = res._written.join("");
      expect(written).toContain("event: connected");
      expect(written).toContain('"type":"connected"');
    });

    it("subscribes to Redis channel on first connection", async () => {
      const req = createMockReq("/events?channel=agents");
      const res = createMockRes();
      await relay.handleSseRequest(req, res);
      expect(subRedis.subscribe).toHaveBeenCalledWith("ck:events:agents");
    });

    it("defaults to 'all' channel when not specified", async () => {
      const req = createMockReq("/events");
      const res = createMockRes();
      await relay.handleSseRequest(req, res);
      expect(subRedis.subscribe).toHaveBeenCalledWith("ck:events:all");
    });

    it("rejects when max connections reached", async () => {
      // Fill up to maxConnections (3)
      for (let i = 0; i < 3; i++) {
        const r = createMockReq("/events?channel=all");
        const s = createMockRes();
        await relay.handleSseRequest(r, s);
      }

      const req = createMockReq("/events?channel=all");
      const res = createMockRes();
      const handled = await relay.handleSseRequest(req, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(503);
    });
  });

  describe("message fan-out", () => {
    it("relays Redis messages to subscribed SSE connections", async () => {
      const req = createMockReq("/events?channel=jobs");
      const res = createMockRes();
      await relay.handleSseRequest(req, res);

      // Simulate Redis message
      const event = JSON.stringify({ type: "job_done", payload: { id: "j-1" } });
      subRedis._emit("message", "ck:events:jobs", event);

      const written = res._written.join("");
      expect(written).toContain("event: message");
      expect(written).toContain(event);
    });
  });

  describe("getStats", () => {
    it("returns relay statistics", () => {
      const stats = relay.getStats();
      expect(stats.ready).toBe(true);
      expect(stats.activeConnections).toBe(0);
      expect(stats.maxConnections).toBe(3);
      expect(stats.subscribedChannels).toBe(0);
    });

    it("reflects active connections", async () => {
      const req = createMockReq("/events?channel=all");
      const res = createMockRes();
      await relay.handleSseRequest(req, res);

      const stats = relay.getStats();
      expect(stats.activeConnections).toBe(1);
      expect(stats.subscribedChannels).toBe(1);
    });
  });

  describe("cleanup on disconnect", () => {
    it("removes connection and unsubscribes when last client disconnects", async () => {
      const req = createMockReq("/events?channel=jobs") as IncomingMessage & {
        _triggerEvent: (e: string) => void;
      };
      const res = createMockRes();
      await relay.handleSseRequest(req, res);
      expect(relay.getStats().activeConnections).toBe(1);

      // Simulate client disconnect
      req._triggerEvent("close");
      expect(relay.getStats().activeConnections).toBe(0);
      expect(subRedis.unsubscribe).toHaveBeenCalledWith("ck:events:jobs");
    });
  });

  describe("stop", () => {
    it("closes all connections and resets state", async () => {
      const req = createMockReq("/events?channel=all");
      const res = createMockRes();
      await relay.handleSseRequest(req, res);

      await relay.stop();
      expect(relay.getStats().ready).toBe(false);
      expect(relay.getStats().activeConnections).toBe(0);
    });
  });
});
