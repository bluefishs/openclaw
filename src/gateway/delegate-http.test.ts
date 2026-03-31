import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskTrackerService } from "../memory/task-tracker.js";
import { handleDelegateHttpRequest, type DelegateHttpOptions } from "./delegate-http.js";
import type { EventRelayService } from "./event-relay.js";

// ─── Mocks ───

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(),
  getOAuthProviders: vi.fn(() => []),
  getOAuthTokenData: vi.fn(),
  refreshOAuthToken: vi.fn(),
  exchangeOAuthCode: vi.fn(),
}));

vi.mock("../commands/agent.js", () => ({
  agentCommand: vi.fn(async () => ({ payloads: [{ text: "delegated answer" }] })),
}));

vi.mock("../cli/deps.js", () => ({
  createDefaultDeps: vi.fn(() => ({})),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {},
}));

// Mock readJsonBody to work with simple mock req objects
vi.mock("./hooks.js", () => ({
  readJsonBody: vi.fn(
    async (req: { on: (event: string, handler: (...args: unknown[]) => void) => void }) => {
      return new Promise<{ ok: true; value: unknown } | { ok: false; error: string }>((resolve) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: unknown) => {
          chunks.push(Buffer.from(chunk as Buffer));
        });
        req.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf-8");
            resolve({ ok: true, value: text ? JSON.parse(text) : {} });
          } catch (err) {
            resolve({ ok: false, error: `Invalid JSON: ${String(err)}` });
          }
        });
      });
    },
  ),
}));

function createMockReq(
  url: string,
  method = "POST",
  headers: Record<string, string> = {},
  body?: unknown,
): IncomingMessage {
  const allHeaders: Record<string, string> = {
    host: "localhost",
    "x-service-token": "test-token",
    "x-correlation-id": "corr-test",
    ...headers,
  };
  const req = {
    url,
    method,
    headers: allHeaders,
    on: vi.fn(),
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;

  // Simulate body reading
  if (body) {
    const buf = Buffer.from(JSON.stringify(body));
    let dataEmitted = false;
    (req as unknown as Record<string, unknown>).on = (
      event: string,
      handler: (...args: unknown[]) => void,
    ) => {
      if (event === "data" && !dataEmitted) {
        dataEmitted = true;
        handler(buf);
      }
      if (event === "end") {
        handler();
      }
      return req;
    };
  }

  return req;
}

function createMockRes(): ServerResponse & { _body: unknown; _status: number } {
  let _body: unknown = null;
  let _status = 200;
  return {
    get _body() {
      return _body;
    },
    get _status() {
      return _status;
    },
    set statusCode(v: number) {
      _status = v;
    },
    get statusCode() {
      return _status;
    },
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => {
      if (data) {
        try {
          _body = JSON.parse(data);
        } catch {
          _body = data;
        }
      }
    }),
    write: vi.fn(),
    flushHeaders: vi.fn(),
  } as unknown as ServerResponse & { _body: unknown; _status: number };
}

function createMockTaskTracker(overrides?: Partial<TaskTrackerService>): TaskTrackerService {
  return {
    createJob: vi.fn(async () => true),
    markRunning: vi.fn(async () => {}),
    markCompleted: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
    getJob: vi.fn(async () => null),
    getStats: vi.fn(() => ({ ready: true, runningJobs: 0, maxConcurrent: 50 })),
    markReady: vi.fn(),
    markNotReady: vi.fn(),
    isReady: true,
    runningCount: 0,
    ...overrides,
  } as unknown as TaskTrackerService;
}

function createMockEventRelay(): EventRelayService {
  return {
    publish: vi.fn(async () => {}),
    handleSseRequest: vi.fn(async () => false),
    getStats: vi.fn(() => ({
      ready: true,
      activeConnections: 0,
      maxConnections: 100,
      subscribedChannels: 0,
    })),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } as unknown as EventRelayService;
}

// Stub env
const _originalEnv = process.env.MCP_SERVICE_TOKEN;
beforeEach(() => {
  process.env.MCP_SERVICE_TOKEN = "test-token";
});

describe("handleDelegateHttpRequest", () => {
  let opts: DelegateHttpOptions;
  let tracker: ReturnType<typeof createMockTaskTracker>;
  let relay: ReturnType<typeof createMockEventRelay>;

  beforeEach(() => {
    tracker = createMockTaskTracker();
    relay = createMockEventRelay();
    opts = {
      auth: {} as unknown as DelegateHttpOptions["auth"],
      taskTracker: tracker,
      eventRelay: relay,
    };
  });

  describe("POST /delegate", () => {
    it("returns false for non-delegate paths", async () => {
      const req = createMockReq("/reason");
      const res = createMockRes();
      const handled = await handleDelegateHttpRequest(req, res, opts);
      expect(handled).toBe(false);
    });

    it("rejects non-POST methods", async () => {
      const req = createMockReq("/delegate", "GET");
      const res = createMockRes();
      const handled = await handleDelegateHttpRequest(req, res, opts);
      expect(handled).toBe(true);
      expect(res._status).toBe(405);
    });

    it("rejects missing agent_id", async () => {
      const req = createMockReq("/delegate", "POST", {}, { payload: { question: "test" } });
      const res = createMockRes();
      const handled = await handleDelegateHttpRequest(req, res, opts);
      expect(handled).toBe(true);
      expect(res._status).toBe(400);
    });

    it("rejects missing payload.question", async () => {
      const req = createMockReq("/delegate", "POST", {}, { agent_id: "test", payload: {} });
      const res = createMockRes();
      const handled = await handleDelegateHttpRequest(req, res, opts);
      expect(handled).toBe(true);
      expect(res._status).toBe(400);
    });

    it("returns 202 with job_id on valid request", async () => {
      const req = createMockReq(
        "/delegate",
        "POST",
        {},
        {
          agent_id: "ck-missive",
          payload: { question: "查詢土地" },
          source: "nemoclaw",
        },
      );
      const res = createMockRes();
      const handled = await handleDelegateHttpRequest(req, res, opts);
      expect(handled).toBe(true);
      expect(res._status).toBe(202);

      const body = res._body as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.job_id).toMatch(/^dlg_/);
      expect(body.status).toBe("pending");
      expect(body.poll_url).toMatch(/^\/tasks\/dlg_/);
      expect(body.events_url).toBe("/events?channel=jobs");
    });

    it("creates job in task tracker and publishes job_created event", async () => {
      const req = createMockReq(
        "/delegate",
        "POST",
        {},
        {
          agent_id: "ck-tunnel",
          payload: { question: "裂縫分析" },
          source: "nemoclaw",
        },
      );
      const res = createMockRes();
      await handleDelegateHttpRequest(req, res, opts);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tracker.createJob).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "ck-tunnel",
          input: "裂縫分析",
          source: "nemoclaw",
        }),
      );
      // V-2.2: job_created event should be published to EventRelay
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(relay.publish).toHaveBeenCalledWith(
        "jobs",
        expect.objectContaining({
          type: "job_created",
          payload: expect.objectContaining({
            agent_id: "ck-tunnel",
            source: "nemoclaw",
          }),
        }),
      );
    });

    it("returns 503 when tracker at capacity", async () => {
      tracker = createMockTaskTracker({
        createJob: vi.fn(async () => false) as unknown as TaskTrackerService["createJob"],
      });
      opts.taskTracker = tracker;

      const req = createMockReq(
        "/delegate",
        "POST",
        {},
        {
          agent_id: "test",
          payload: { question: "test" },
        },
      );
      const res = createMockRes();
      const handled = await handleDelegateHttpRequest(req, res, opts);
      expect(handled).toBe(true);
      expect(res._status).toBe(503);
    });
  });

  describe("GET /tasks/{job_id}", () => {
    it("returns job status when found", async () => {
      const mockJob = {
        job_id: "dlg_123",
        status: "completed",
        agent_id: "ck-missive",
        input: "test",
        result: '{"answer":"done"}',
        error: null,
        source: "nemoclaw",
        correlation_id: "corr-1",
        created_at: "2026-03-22T00:00:00Z",
        updated_at: "2026-03-22T00:01:00Z",
      };
      tracker = createMockTaskTracker({
        getJob: vi.fn(async () => mockJob) as unknown as TaskTrackerService["getJob"],
      });
      opts.taskTracker = tracker;

      const req = createMockReq("/tasks/dlg_123", "GET");
      const res = createMockRes();
      const handled = await handleDelegateHttpRequest(req, res, opts);
      expect(handled).toBe(true);
      expect(res._status).toBe(200);
      expect((res._body as Record<string, Record<string, unknown>>).job.status).toBe("completed");
    });

    it("returns 404 for unknown job", async () => {
      const req = createMockReq("/tasks/nonexistent", "GET");
      const res = createMockRes();
      const handled = await handleDelegateHttpRequest(req, res, opts);
      expect(handled).toBe(true);
      expect(res._status).toBe(404);
    });

    it("rejects non-GET methods", async () => {
      const req = createMockReq("/tasks/dlg_123", "POST");
      const res = createMockRes();
      const handled = await handleDelegateHttpRequest(req, res, opts);
      expect(handled).toBe(true);
      expect(res._status).toBe(405);
    });
  });

  describe("authentication", () => {
    it("rejects invalid service token", async () => {
      const req = createMockReq(
        "/delegate",
        "POST",
        { "x-service-token": "wrong-token" },
        {
          agent_id: "test",
          payload: { question: "test" },
        },
      );
      const res = createMockRes();
      const handled = await handleDelegateHttpRequest(req, res, opts);
      expect(handled).toBe(true);
      expect(res._status).toBe(401);
    });
  });
});
