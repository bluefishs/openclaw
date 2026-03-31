import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkflowSseController, type WorkflowSseState } from "./workflow-sse.ts";

// ─── Mock EventSource ───

type MockESListener = (ev: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, MockESListener[]>();
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: MockESListener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  close(): void {
    this.readyState = 2;
  }

  /** Test helper — simulate SSE open */
  _open(): void {
    this.readyState = 1;
    for (const fn of this.listeners.get("open") ?? []) {
      fn(new MessageEvent("open"));
    }
  }

  /** Test helper — simulate SSE error */
  _error(): void {
    for (const fn of this.listeners.get("error") ?? []) {
      fn(new MessageEvent("error"));
    }
  }

  /** Test helper — dispatch a message event */
  _message(data: unknown): void {
    const ev = new MessageEvent("message", { data: JSON.stringify(data) });
    for (const fn of this.listeners.get("message") ?? []) {
      fn(ev);
    }
  }

  static reset(): void {
    MockEventSource.instances = [];
  }
}

// ─── Mock fetch for ticket exchange ───

function mockFetchTicket(ticket = "mock-ticket-abc"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ticket }),
    }),
  );
}

function mockFetchTicketFail(status = 503): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status }));
}

function mockFetchThrow(): void {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
}

// ─── Helpers ───

function makeController(token = "test-token"): {
  ctrl: WorkflowSseController;
  states: WorkflowSseState[];
} {
  const states: WorkflowSseState[] = [];
  const ctrl = new WorkflowSseController("http://localhost:18789", token, {
    onStateChange: (s) => states.push({ ...s }),
  });
  return { ctrl, states };
}

function latestES(): MockEventSource {
  return MockEventSource.instances[MockEventSource.instances.length - 1];
}

// ─── Tests ───

describe("WorkflowSseController", () => {
  beforeEach(() => {
    MockEventSource.reset();
    vi.stubGlobal("EventSource", MockEventSource);
    vi.useFakeTimers();
    mockFetchTicket();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── Ticket Exchange ───

  describe("ticket exchange", () => {
    it("uses ticket from exchange in SSE URL", async () => {
      mockFetchTicket("my-ticket-xyz");
      const { ctrl } = makeController("my-secret");
      await ctrl.connect();
      const es = latestES();
      expect(es.url).toBe("http://localhost:18789/events?channel=workflow&ticket=my-ticket-xyz");
      // Verify fetch was called with correct service token header
      expect(fetch).toHaveBeenCalledWith("http://localhost:18789/events/ticket", {
        method: "POST",
        headers: { "X-Service-Token": "my-secret" },
      });
      ctrl.dispose();
    });

    it("falls back to legacy ?token= when ticket exchange fails", async () => {
      mockFetchTicketFail(503);
      const { ctrl } = makeController("my-secret");
      await ctrl.connect();
      const es = latestES();
      expect(es.url).toBe("http://localhost:18789/events?channel=workflow&token=my-secret");
      ctrl.dispose();
    });

    it("falls back to legacy ?token= on network error", async () => {
      mockFetchThrow();
      const { ctrl } = makeController("my-secret");
      await ctrl.connect();
      const es = latestES();
      expect(es.url).toBe("http://localhost:18789/events?channel=workflow&token=my-secret");
      ctrl.dispose();
    });

    it("omits both ticket and token when serviceToken is empty", async () => {
      const { ctrl } = makeController("");
      await ctrl.connect();
      const es = latestES();
      expect(es.url).toBe("http://localhost:18789/events?channel=workflow");
      // Should NOT call fetch for ticket
      expect(fetch).not.toHaveBeenCalled();
      ctrl.dispose();
    });
  });

  // ─── Connection ───

  it("sets connected=true on open", async () => {
    const { ctrl, states } = makeController();
    await ctrl.connect();
    latestES()._open();
    expect(states.length).toBe(1);
    expect(states[0].connected).toBe(true);
    ctrl.dispose();
  });

  it("sets connected=false on error and schedules reconnect", async () => {
    const { ctrl, states } = makeController();
    await ctrl.connect();
    latestES()._open();
    latestES()._error();
    expect(states.at(-1)!.connected).toBe(false);

    // Advance past reconnect base (1000ms + some jitter)
    await vi.advanceTimersByTimeAsync(1600);
    // Should have created a new EventSource (2nd connect → 2nd ticket exchange)
    expect(MockEventSource.instances.length).toBe(2);
    ctrl.dispose();
  });

  it("does not reconnect after dispose", async () => {
    const { ctrl } = makeController();
    await ctrl.connect();
    ctrl.dispose();
    latestES()._error();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockEventSource.instances.length).toBe(1);
  });

  // ─── Event Handling ───

  it("handles workflow_started event", async () => {
    const { ctrl } = makeController();
    await ctrl.connect();
    latestES()._open();

    latestES()._message({
      type: "workflow_started",
      payload: {
        workflow_id: "wf-1",
        definition_id: "dev-cycle",
        definition_name: "Dev Cycle",
        total_steps: 4,
      },
      timestamp: "2026-03-24T10:00:00Z",
    });

    const instances = ctrl.getInstancesArray();
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      workflowId: "wf-1",
      definitionId: "dev-cycle",
      status: "running",
      currentStep: 0,
      totalSteps: 4,
    });
    ctrl.dispose();
  });

  it("handles workflow_step_started event", async () => {
    const { ctrl } = makeController();
    await ctrl.connect();
    latestES()._open();

    latestES()._message({
      type: "workflow_started",
      payload: { workflow_id: "wf-1", total_steps: 3 },
      timestamp: "2026-03-24T10:00:00Z",
    });

    latestES()._message({
      type: "workflow_step_started",
      payload: { workflow_id: "wf-1", step_index: 0, agent_id: "gstack-eng" },
      timestamp: "2026-03-24T10:00:01Z",
    });

    const inst = ctrl.getInstancesArray()[0];
    expect(inst.currentStep).toBe(1);
    expect(inst.lastEvent).toBe("step:1:gstack-eng");
    ctrl.dispose();
  });

  it("handles workflow_completed event", async () => {
    const { ctrl } = makeController();
    await ctrl.connect();
    latestES()._open();

    latestES()._message({
      type: "workflow_started",
      payload: { workflow_id: "wf-1", total_steps: 2 },
      timestamp: "2026-03-24T10:00:00Z",
    });
    latestES()._message({
      type: "workflow_completed",
      payload: { workflow_id: "wf-1" },
      timestamp: "2026-03-24T10:00:02Z",
    });

    const inst = ctrl.getInstancesArray()[0];
    expect(inst.status).toBe("completed");
    expect(inst.currentStep).toBe(2);
    ctrl.dispose();
  });

  it("handles workflow_failed event", async () => {
    const { ctrl } = makeController();
    await ctrl.connect();
    latestES()._open();

    latestES()._message({
      type: "workflow_started",
      payload: { workflow_id: "wf-1", total_steps: 3 },
      timestamp: "2026-03-24T10:00:00Z",
    });
    latestES()._message({
      type: "workflow_failed",
      payload: { workflow_id: "wf-1", reason: "timeout" },
      timestamp: "2026-03-24T10:00:05Z",
    });

    const inst = ctrl.getInstancesArray()[0];
    expect(inst.status).toBe("failed");
    expect(inst.lastEvent).toBe("failed:timeout");
    ctrl.dispose();
  });

  it("handles workflow_paused event", async () => {
    const { ctrl } = makeController();
    await ctrl.connect();
    latestES()._open();

    latestES()._message({
      type: "workflow_started",
      payload: { workflow_id: "wf-1", total_steps: 3 },
      timestamp: "2026-03-24T10:00:00Z",
    });
    latestES()._message({
      type: "workflow_paused",
      payload: { workflow_id: "wf-1", reason: "approval required" },
      timestamp: "2026-03-24T10:00:02Z",
    });

    const inst = ctrl.getInstancesArray()[0];
    expect(inst.status).toBe("paused");
    ctrl.dispose();
  });

  // ─── Sorting ───

  it("sorts instances: running > paused > failed > completed", async () => {
    const { ctrl } = makeController();
    await ctrl.connect();
    latestES()._open();

    for (const id of ["a", "b", "c", "d"]) {
      latestES()._message({
        type: "workflow_started",
        payload: { workflow_id: id, total_steps: 2 },
        timestamp: "2026-03-24T10:00:00Z",
      });
    }
    latestES()._message({
      type: "workflow_completed",
      payload: { workflow_id: "a" },
      timestamp: "2026-03-24T10:00:01Z",
    });
    latestES()._message({
      type: "workflow_failed",
      payload: { workflow_id: "b" },
      timestamp: "2026-03-24T10:00:01Z",
    });
    latestES()._message({
      type: "workflow_paused",
      payload: { workflow_id: "c" },
      timestamp: "2026-03-24T10:00:01Z",
    });

    const sorted = ctrl.getInstancesArray();
    expect(sorted.map((i) => i.workflowId)).toEqual(["d", "c", "b", "a"]);
    ctrl.dispose();
  });

  // ─── Eviction ───

  it("evicts oldest completed/failed when max instances reached", async () => {
    const { ctrl } = makeController();
    await ctrl.connect();
    latestES()._open();

    for (let i = 0; i < 50; i++) {
      latestES()._message({
        type: "workflow_started",
        payload: { workflow_id: `wf-${i}`, total_steps: 1 },
        timestamp: "2026-03-24T10:00:00Z",
      });
    }
    latestES()._message({
      type: "workflow_completed",
      payload: { workflow_id: "wf-0" },
      timestamp: "2026-03-24T10:00:01Z",
    });

    latestES()._message({
      type: "workflow_started",
      payload: { workflow_id: "wf-50", total_steps: 1 },
      timestamp: "2026-03-24T10:00:02Z",
    });

    const state = ctrl.getState();
    expect(state.instances.size).toBe(50);
    expect(state.instances.has("wf-0")).toBe(false);
    expect(state.instances.has("wf-50")).toBe(true);
    ctrl.dispose();
  });

  // ─── Event Feed Limit ───

  it("limits event feed to MAX_EVENTS (100)", async () => {
    const { ctrl } = makeController();
    await ctrl.connect();
    latestES()._open();

    for (let i = 0; i < 110; i++) {
      latestES()._message({
        type: "workflow_started",
        payload: { workflow_id: `wf-${i}`, total_steps: 1 },
        timestamp: `2026-03-24T10:00:${String(i).padStart(2, "0")}Z`,
      });
    }

    const state = ctrl.getState();
    expect(state.events.length).toBe(100);
    expect(state.events[0].payload.workflow_id).toBe("wf-109");
    ctrl.dispose();
  });

  // ─── Malformed Events ───

  it("ignores events without workflow_id", async () => {
    const { ctrl } = makeController();
    await ctrl.connect();
    latestES()._open();

    latestES()._message({
      type: "workflow_completed",
      payload: {},
      timestamp: "2026-03-24T10:00:00Z",
    });

    expect(ctrl.getInstancesArray()).toHaveLength(0);
    expect(ctrl.getState().events).toHaveLength(1);
    ctrl.dispose();
  });

  it("ignores malformed JSON", async () => {
    const { ctrl } = makeController();
    await ctrl.connect();
    latestES()._open();

    const es = latestES();
    const ev = new MessageEvent("message", { data: "not-json" });
    for (const fn of (es as unknown as { listeners: Map<string, MockESListener[]> }).listeners.get(
      "message",
    ) ?? []) {
      fn(ev);
    }

    expect(ctrl.getInstancesArray()).toHaveLength(0);
    expect(ctrl.getState().events).toHaveLength(0);
    ctrl.dispose();
  });
});
