import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EventRelayService } from "./event-relay.js";
import { WorkflowEngine, BUILTIN_WORKFLOWS, type DelegateFunction } from "./workflow-chain.js";

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

describe("WorkflowEngine", () => {
  let engine: WorkflowEngine;
  let relay: ReturnType<typeof createMockRelay>;
  let delegateFn: ReturnType<typeof createMockDelegate>;

  beforeEach(() => {
    jobCounter = 0;
    engine = new WorkflowEngine({ maxConcurrent: 5 });
    relay = createMockRelay();
    delegateFn = createMockDelegate();
    engine.setEventRelay(relay);
    engine.setDelegateFn(delegateFn);
    engine.registerBuiltins();
  });

  describe("registration", () => {
    it("registers built-in workflows", () => {
      const defs = engine.getAllDefinitions();
      expect(defs.length).toBe(BUILTIN_WORKFLOWS.length);
    });

    it("can retrieve a definition by ID", () => {
      const def = engine.getDefinition("dev-cycle");
      expect(def).toBeDefined();
      expect(def!.name).toContain("開發循環");
    });
  });

  describe("startWorkflow", () => {
    it("starts a workflow and returns a workflow ID", async () => {
      const wfId = await engine.startWorkflow("dev-cycle", "實作用戶認證系統");
      expect(wfId).toBeTruthy();
      expect(wfId!).toMatch(/^wf_[0-9a-f-]+$/);
    });

    it("executes the first step via delegate", async () => {
      await engine.startWorkflow("dev-cycle", "實作搜尋功能");
      expect(delegateFn).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "gstack-eng",
          question: "實作搜尋功能",
          source: "workflow:dev-cycle",
        }),
      );
    });

    it("publishes workflow_started event", async () => {
      await engine.startWorkflow("dev-cycle", "test");
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(relay.publish).toHaveBeenCalledWith(
        "workflow",
        expect.objectContaining({ type: "workflow_started" }),
      );
    });

    it("returns null for unknown definition", async () => {
      const wfId = await engine.startWorkflow("nonexistent", "test");
      expect(wfId).toBeNull();
    });

    it("returns null when at max concurrent", async () => {
      for (let i = 0; i < 5; i++) {
        await engine.startWorkflow("dev-cycle", `task-${i}`);
      }
      const wfId = await engine.startWorkflow("dev-cycle", "overflow");
      expect(wfId).toBeNull();
    });

    it("returns null when no delegate function set", async () => {
      const empty = new WorkflowEngine();
      empty.registerBuiltins();
      const wfId = await empty.startWorkflow("dev-cycle", "test");
      expect(wfId).toBeNull();
    });
  });

  describe("onJobEvent — advancing workflow", () => {
    it("advances to next step on completion", async () => {
      const wfId = await engine.startWorkflow("dev-cycle", "build feature X");
      expect(wfId).toBeTruthy();

      // First step (gstack-eng) completed — should trigger gstack-qa
      await engine.onJobEvent("job_1", "completed", "實作完成：新增 X 功能");

      expect(delegateFn).toHaveBeenCalledTimes(2);
      expect(delegateFn).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agentId: "gstack-qa",
          question: "實作完成：新增 X 功能",
        }),
      );
    });

    it("publishes workflow_step_started on each step", async () => {
      await engine.startWorkflow("dev-cycle", "test");
      await engine.onJobEvent("job_1", "completed", "done");

      const stepEvents = (relay.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([, event]: [string, { type: string }]) => event.type === "workflow_step_started",
      );
      expect(stepEvents.length).toBeGreaterThanOrEqual(2);
    });

    it("completes workflow when all steps finish", async () => {
      await engine.startWorkflow("dev-cycle", "test");

      // Step 1: gstack-eng completes
      await engine.onJobEvent("job_1", "completed", "eng done");

      // Step 2: gstack-qa completes — but step 3 requires approval
      await engine.onJobEvent("job_2", "completed", "qa passed");

      // Workflow should be paused (step 3 requires approval)
      const instance = engine.getActiveInstances().find((i) => i.definitionId === "dev-cycle");
      expect(instance?.status).toBe("paused");
    });

    it("fails workflow when step fails after exhausting retries", async () => {
      await engine.startWorkflow("dev-cycle", "test");

      // gstack-eng fails — default maxRetries=1, so first failure triggers retry
      await engine.onJobEvent("job_1", "failed", "compilation error");
      // Retry was attempted (job_2 created), still active
      expect(engine.getActiveInstances()).toHaveLength(1);

      // Second failure exhausts retries — workflow should fail
      await engine.onJobEvent(`job_${jobCounter}`, "failed", "still broken");
      expect(engine.getActiveInstances()).toHaveLength(0);

      // Should have published workflow_failed
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(relay.publish).toHaveBeenCalledWith(
        "workflow",
        expect.objectContaining({ type: "workflow_failed" }),
      );
    });

    it("ignores events for unknown jobs", async () => {
      const beforeStats = engine.getStats();
      await engine.onJobEvent("unknown_job", "completed", "result");
      const afterStats = engine.getStats();
      expect(beforeStats.activeInstances).toBe(afterStats.activeInstances);
    });
  });

  describe("qa-fix-loop workflow", () => {
    it("chains QA → Eng → QA on completion", async () => {
      const wfId = await engine.startWorkflow("qa-fix-loop", "test login flow");
      expect(wfId).toBeTruthy();

      // Step 0: gstack-qa completes → triggers step 1 (gstack-eng)
      await engine.onJobEvent("job_1", "completed", "QA 結果：登入流程有 2 個 bug");
      expect(delegateFn).toHaveBeenCalledTimes(2);
      expect(delegateFn).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentId: "gstack-eng" }),
      );

      // Step 1: gstack-eng completes → triggers step 2 (gstack-qa verification)
      await engine.onJobEvent("job_2", "completed", "已修復 2 個 bug");
      expect(delegateFn).toHaveBeenCalledTimes(3);
      expect(delegateFn).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentId: "gstack-qa" }),
      );
    });

    it("retries gstack-eng step on failure (maxRetries: 2)", async () => {
      await engine.startWorkflow("qa-fix-loop", "test login flow");
      // Step 0 completes
      await engine.onJobEvent("job_1", "completed", "QA found bugs");

      // Step 1 (gstack-eng) fails — should retry (maxRetries: 2)
      await engine.onJobEvent("job_2", "failed", "build error");
      expect(engine.getActiveInstances()).toHaveLength(1);

      // Second failure — still has retries left
      await engine.onJobEvent(`job_${jobCounter}`, "failed", "still broken");
      expect(engine.getActiveInstances()).toHaveLength(1);

      // Third failure — retries exhausted, workflow fails
      await engine.onJobEvent(`job_${jobCounter}`, "failed", "gave up");
      expect(engine.getActiveInstances()).toHaveLength(0);
    });
  });

  describe("resumeWorkflow", () => {
    it("resumes a paused workflow", async () => {
      await engine.startWorkflow("dev-cycle", "feature Y");
      await engine.onJobEvent("job_1", "completed", "eng done");
      await engine.onJobEvent("job_2", "completed", "qa passed");

      // Should be paused at ship step (requires approval)
      const instances = engine.getActiveInstances();
      const paused = instances.find((i) => i.status === "paused");
      expect(paused).toBeDefined();

      const resumed = await engine.resumeWorkflow(paused!.workflowId);
      expect(resumed).toBe(true);
      expect(delegateFn).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "gstack-ship",
        }),
      );
    });

    it("returns false for non-paused workflow", async () => {
      const wfId = await engine.startWorkflow("dev-cycle", "test");
      const resumed = await engine.resumeWorkflow(wfId!);
      expect(resumed).toBe(false); // still running, not paused
    });

    it("returns false for unknown workflow", async () => {
      const resumed = await engine.resumeWorkflow("wf_nonexistent");
      expect(resumed).toBe(false);
    });
  });

  describe("max depth guard", () => {
    it("fails workflow when max depth exceeded", async () => {
      // Create a custom workflow with low maxDepth
      engine.registerWorkflow({
        id: "short-chain",
        name: "短鏈",
        steps: [
          { agentId: "gstack-eng", triggerOn: "completed", contextFrom: "original_input" },
          { agentId: "gstack-qa", triggerOn: "completed", contextFrom: "previous_result" },
        ],
        maxDepth: 1,
      });

      await engine.startWorkflow("short-chain", "test");
      // Step 0 completes — but we've already hit depth 1
      await engine.onJobEvent(`job_${jobCounter}`, "completed", "done");

      // Should have published workflow_failed with max_depth_exceeded
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(relay.publish).toHaveBeenCalledWith(
        "workflow",
        expect.objectContaining({
          type: "workflow_failed",
          payload: expect.objectContaining({ reason: "max_depth_exceeded" }),
        }),
      );
    });
  });

  describe("cancelWorkflow", () => {
    it("removes the workflow instance", async () => {
      const wfId = await engine.startWorkflow("dev-cycle", "test");
      expect(engine.getStats().activeInstances).toBe(1);
      const ok = await engine.cancelWorkflow(wfId!);
      expect(ok).toBe(true);
      expect(engine.getStats().activeInstances).toBe(0);
    });

    it("returns false for unknown workflow", async () => {
      expect(await engine.cancelWorkflow("wf_nonexistent")).toBe(false);
    });
  });

  describe("delegation failure", () => {
    it("fails workflow when delegate returns null", async () => {
      const failDelegate = vi.fn(async () => null);
      engine.setDelegateFn(failDelegate);

      const wfId = await engine.startWorkflow("dev-cycle", "test");
      // Workflow should have been created then immediately failed
      expect(wfId).toBeTruthy();
      expect(engine.getStats().activeInstances).toBe(0);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(relay.publish).toHaveBeenCalledWith(
        "workflow",
        expect.objectContaining({
          type: "workflow_failed",
          payload: expect.objectContaining({ reason: "delegation_failed" }),
        }),
      );
    });
  });

  describe("contextFrom: both", () => {
    it("combines original input and previous result", async () => {
      // review-cycle step 2 (gstack-review) uses contextFrom: "both"
      await engine.startWorkflow("review-cycle", "評估 X 功能");

      // Step 0 (gstack-ceo) completes
      await engine.onJobEvent("job_1", "completed", "CEO 評估完成");
      // Step 1 (gstack-eng) completes
      await engine.onJobEvent("job_2", "completed", "工程方案已確定");

      // Step 2 should be called with both original + previous
      expect(delegateFn).toHaveBeenCalledTimes(3);
      const lastCall = (delegateFn as ReturnType<typeof vi.fn>).mock.calls[2][0] as {
        question: string;
        agentId: string;
      };
      expect(lastCall.agentId).toBe("gstack-review");
      expect(lastCall.question).toContain("評估 X 功能"); // original
      expect(lastCall.question).toContain("工程方案已確定"); // previous result
    });
  });

  describe("reapStaleInstances", () => {
    it("reaps instances older than maxAge", async () => {
      vi.useFakeTimers();
      try {
        await engine.startWorkflow("dev-cycle", "test");
        expect(engine.getStats().activeInstances).toBe(1);

        vi.advanceTimersByTime(3_700_000); // > 1 hour default
        const reaped = engine.reapStaleInstances();
        expect(reaped).toBe(1);
        expect(engine.getStats().activeInstances).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not reap fresh instances", async () => {
      await engine.startWorkflow("dev-cycle", "test");
      const reaped = engine.reapStaleInstances();
      expect(reaped).toBe(0);
      expect(engine.getStats().activeInstances).toBe(1);
    });
  });

  describe("getStats", () => {
    it("returns engine statistics", () => {
      const stats = engine.getStats();
      expect(stats.definitions).toBe(BUILTIN_WORKFLOWS.length);
      expect(stats.activeInstances).toBe(0);
      expect(stats.maxConcurrent).toBe(5);
    });

    it("reflects active instances", async () => {
      await engine.startWorkflow("dev-cycle", "test");
      expect(engine.getStats().activeInstances).toBe(1);
    });
  });
});
