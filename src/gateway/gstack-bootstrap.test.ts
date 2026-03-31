import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventRelayService } from "./event-relay.js";
import {
  bootstrapGstack,
  shutdownGstack,
  getActiveWorkflowEngine,
  type GstackBootstrapOptions,
} from "./gstack-bootstrap.js";
import { getDefaultRegistry, setDefaultRegistry, createDefaultRegistry } from "./leader-agent.js";
import type { DelegateFunction } from "./workflow-chain.js";

// ─── Mocks ───

function createMockRelay(): EventRelayService {
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

let jobCounter = 0;
function createMockDelegate(): DelegateFunction {
  return vi.fn(async () => {
    jobCounter++;
    return { jobId: `job_${jobCounter}` };
  });
}

function createOpts(overrides?: Partial<GstackBootstrapOptions>): GstackBootstrapOptions {
  return {
    eventRelay: createMockRelay(),
    delegateFn: createMockDelegate(),
    ...overrides,
  };
}

describe("gstack-bootstrap", () => {
  beforeEach(() => {
    jobCounter = 0;
    shutdownGstack();
    // Reset to fresh registry for each test
    setDefaultRegistry(createDefaultRegistry());
  });

  afterEach(() => {
    shutdownGstack();
  });

  describe("bootstrapGstack", () => {
    it("registers gstack roles into default registry", () => {
      const result = bootstrapGstack(createOpts());
      expect(result.gstackRolesRegistered).toBeGreaterThanOrEqual(8);

      const registry = getDefaultRegistry();
      expect(registry.has("gstack-ceo")).toBe(true);
      expect(registry.has("gstack-eng")).toBe(true);
      expect(registry.has("gstack-qa")).toBe(true);
      expect(registry.has("gstack-ship")).toBe(true);
    });

    it("returns a WorkflowEngine with built-in definitions", () => {
      const result = bootstrapGstack(createOpts());
      const engine = result.workflowEngine;
      expect(engine.getDefinition("dev-cycle")).toBeDefined();
      expect(engine.getDefinition("qa-fix-loop")).toBeDefined();
      expect(engine.getDefinition("review-cycle")).toBeDefined();
    });

    it("sets active workflow engine", () => {
      expect(getActiveWorkflowEngine()).toBeNull();
      bootstrapGstack(createOpts());
      expect(getActiveWorkflowEngine()).not.toBeNull();
    });

    it("is idempotent — second call cleans up first", () => {
      const result1 = bootstrapGstack(createOpts());
      const result2 = bootstrapGstack(createOpts());
      // Engine should be different instances
      expect(result1.workflowEngine).not.toBe(result2.workflowEngine);
      expect(getActiveWorkflowEngine()).toBe(result2.workflowEngine);
    });

    it("can start a workflow via the engine", async () => {
      const delegate = createMockDelegate();
      const result = bootstrapGstack(createOpts({ delegateFn: delegate }));
      const wfId = await result.workflowEngine.startWorkflow("dev-cycle", "test feature");
      expect(wfId).toBeTruthy();
      expect(delegate).toHaveBeenCalledWith(expect.objectContaining({ agentId: "gstack-eng" }));
    });
  });

  describe("shutdownGstack", () => {
    it("clears active engine", () => {
      bootstrapGstack(createOpts());
      expect(getActiveWorkflowEngine()).not.toBeNull();
      shutdownGstack();
      expect(getActiveWorkflowEngine()).toBeNull();
    });

    it("is safe to call multiple times", () => {
      shutdownGstack();
      shutdownGstack();
      expect(getActiveWorkflowEngine()).toBeNull();
    });
  });

  describe("periodic reap", () => {
    it("reaps stale instances after interval", async () => {
      vi.useFakeTimers();
      try {
        const result = bootstrapGstack(
          createOpts({
            reapIntervalMs: 1000,
            reapMaxAgeMs: 500,
          }),
        );

        // Start a workflow to create an instance
        await result.workflowEngine.startWorkflow("dev-cycle", "test");
        expect(result.workflowEngine.getStats().activeInstances).toBe(1);

        // Advance time past the reap threshold
        vi.advanceTimersByTime(1500);

        // Instance should be reaped
        expect(result.workflowEngine.getStats().activeInstances).toBe(0);
      } finally {
        vi.useRealTimers();
        shutdownGstack();
      }
    });
  });

  describe("end-to-end workflow chain", () => {
    it("bootstrap → start → delegate → complete → advance → event publish", async () => {
      const relay = createMockRelay();
      const delegate = createMockDelegate();
      const result = bootstrapGstack(createOpts({ eventRelay: relay, delegateFn: delegate }));
      const engine = result.workflowEngine;

      // 1. Start a dev-cycle workflow
      const wfId = await engine.startWorkflow("dev-cycle", "implement feature X");
      expect(wfId).toBeTruthy();
      expect(engine.getStats().activeInstances).toBe(1);

      // 2. Delegate should have been called for gstack-eng (first step)
      expect(delegate).toHaveBeenCalledTimes(1);
      const delegateCall = (delegate as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(delegateCall.agentId).toBe("gstack-eng");
      const jobId = `job_${jobCounter}`;

      // 3. Simulate job completion → triggers workflow advance
      await engine.onJobEvent(jobId, "completed", "code written", "corr-1");

      // 4. Should have delegated next step (gstack-qa)
      expect(delegate).toHaveBeenCalledTimes(2);
      const secondCall = (delegate as ReturnType<typeof vi.fn>).mock.calls[1][0] as Record<
        string,
        unknown
      >;
      expect(secondCall.agentId).toBe("gstack-qa");

      // 5. Event relay should have been called with workflow events
      const publishCalls = (relay.publish as ReturnType<typeof vi.fn>).mock.calls;
      const eventTypes = publishCalls.map((c: unknown[]) => (c[1] as { type: string }).type);
      expect(eventTypes).toContain("workflow_started");
      expect(eventTypes).toContain("workflow_step_started");
    });

    it("bootstrap → start → delegate fail → workflow_failed event", async () => {
      const relay = createMockRelay();
      const failDelegate = vi.fn(async () => null);
      const result = bootstrapGstack(createOpts({ eventRelay: relay, delegateFn: failDelegate }));
      const engine = result.workflowEngine;

      // startWorkflow returns wfId even when first step delegation fails
      // (the workflow is created, then executeCurrentStep handles the failure internally)
      const wfId = await engine.startWorkflow("dev-cycle", "doomed feature");
      expect(wfId).toBeTruthy();

      // Instance should have been removed after failure
      expect(engine.getStats().activeInstances).toBe(0);

      // Event relay should have published workflow_started then workflow_failed
      const publishCalls = (relay.publish as ReturnType<typeof vi.fn>).mock.calls;
      const eventTypes = publishCalls.map((c: unknown[]) => (c[1] as { type: string }).type);
      expect(eventTypes).toContain("workflow_started");
      expect(eventTypes).toContain("workflow_failed");
    });

    it("bootstrap → cancel → workflow_cancelled event", async () => {
      const relay = createMockRelay();
      const delegate = createMockDelegate();
      const result = bootstrapGstack(createOpts({ eventRelay: relay, delegateFn: delegate }));
      const engine = result.workflowEngine;

      const wfId = await engine.startWorkflow("dev-cycle", "cancel test");
      expect(wfId).toBeTruthy();

      const ok = await engine.cancelWorkflow(wfId!);
      expect(ok).toBe(true);
      expect(engine.getStats().activeInstances).toBe(0);

      const publishCalls = (relay.publish as ReturnType<typeof vi.fn>).mock.calls;
      const eventTypes = publishCalls.map((c: unknown[]) => (c[1] as { type: string }).type);
      expect(eventTypes).toContain("workflow_cancelled");
    });
  });
});
