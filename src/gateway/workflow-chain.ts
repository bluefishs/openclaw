/**
 * WorkflowChain — Event-driven agent coordination engine
 *
 * Enables automatic chaining of gstack cognitive roles:
 *   Plan → Implement → QA → Ship (happy path)
 *   QA fail → Engineer retry → QA re-test (closed loop)
 *
 * Architecture:
 *   WorkflowEngine listens to EventRelay "jobs" channel events.
 *   When a job completes/fails, it checks if a workflow chain has a next step.
 *   If so, it auto-delegates to the next agent via the delegate endpoint.
 *
 * Safety:
 *   - maxRetries per step prevents infinite loops
 *   - maxDepth per workflow prevents unbounded chaining
 *   - approval gates can pause workflow mid-chain
 */

import { randomUUID } from "node:crypto";
import type { EventRelayService, RelayEvent } from "./event-relay.js";

// ─── Types ───

export type WorkflowStep = {
  /** Agent to invoke at this step */
  agentId: string;
  /** What triggers this step from the previous step's outcome */
  triggerOn: "completed" | "failed";
  /** Where to get context for this step's input */
  contextFrom: "previous_result" | "original_input" | "both";
  /**
   * Max retry attempts for this step (excludes the initial execution).
   * e.g., maxRetries=2 means up to 3 total executions (1 initial + 2 retries).
   * Default: 1, capped at MAX_RETRIES_CAP (5).
   */
  maxRetries?: number;
  /** If true, require human approval before executing (uses TaskTracker approval gate) */
  requireApproval?: boolean;
};

export type WorkflowDefinition = {
  id: string;
  name: string;
  steps: WorkflowStep[];
  /** Max total depth to prevent runaway chains (default: 10) */
  maxDepth?: number;
};

export type WorkflowInstance = {
  workflowId: string;
  definitionId: string;
  /** Original input that started the workflow */
  originalInput: string;
  /** Current step index (0-based) */
  currentStep: number;
  /** Retry count for current step */
  retryCount: number;
  /** Job IDs for each completed step */
  stepJobIds: string[];
  /** Last result from the previous step */
  lastResult: string | null;
  /** Timestamp of workflow start */
  startedAt: string;
  status: "running" | "completed" | "failed" | "paused";
};

// ─── Workflow Definitions ───

export const BUILTIN_WORKFLOWS: WorkflowDefinition[] = [
  {
    id: "dev-cycle",
    name: "開發循環 (Plan → QA → Ship)",
    steps: [
      {
        agentId: "gstack-eng",
        triggerOn: "completed",
        contextFrom: "original_input",
      },
      {
        agentId: "gstack-qa",
        triggerOn: "completed",
        contextFrom: "previous_result",
      },
      {
        agentId: "gstack-ship",
        triggerOn: "completed",
        contextFrom: "previous_result",
        requireApproval: true,
      },
    ],
    maxDepth: 10,
  },
  {
    id: "qa-fix-loop",
    name: "QA 修復閉環 (QA → Engineer 修復 → QA 驗證)",
    steps: [
      {
        agentId: "gstack-qa",
        triggerOn: "completed",
        contextFrom: "original_input",
      },
      {
        agentId: "gstack-eng",
        triggerOn: "completed",
        contextFrom: "both",
        maxRetries: 2,
      },
      {
        agentId: "gstack-qa",
        triggerOn: "completed",
        contextFrom: "previous_result",
      },
    ],
    maxDepth: 6,
  },
  {
    id: "review-cycle",
    name: "審查循環 (CEO → Eng → Review)",
    steps: [
      {
        agentId: "gstack-ceo",
        triggerOn: "completed",
        contextFrom: "original_input",
      },
      {
        agentId: "gstack-eng",
        triggerOn: "completed",
        contextFrom: "previous_result",
      },
      {
        agentId: "gstack-review",
        triggerOn: "completed",
        contextFrom: "both",
      },
    ],
    maxDepth: 10,
  },
];

// ─── Workflow Engine ───

export type DelegateFunction = (params: {
  agentId: string;
  question: string;
  source: string;
  correlationId?: string;
}) => Promise<{ jobId: string } | null>;

export type WorkflowEngineConfig = {
  /** Max concurrent workflow instances (default: 10) */
  maxConcurrent: number;
};

const DEFAULT_ENGINE_CONFIG: WorkflowEngineConfig = {
  maxConcurrent: 10,
};

export class WorkflowEngine {
  private definitions = new Map<string, WorkflowDefinition>();
  private instances = new Map<string, WorkflowInstance>();
  /** Reverse index: jobId → workflowId for O(1) lookup in onJobEvent */
  private jobIndex = new Map<string, string>();
  private config: WorkflowEngineConfig;
  private delegateFn: DelegateFunction | null = null;
  private eventRelay: EventRelayService | null = null;

  constructor(config?: Partial<WorkflowEngineConfig>) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
  }

  /** Register delegate function for creating sub-tasks */
  setDelegateFn(fn: DelegateFunction): void {
    this.delegateFn = fn;
  }

  /** Set EventRelay for publishing workflow events */
  setEventRelay(relay: EventRelayService): void {
    this.eventRelay = relay;
  }

  /** Max retries cap to prevent CPU spin */
  private static readonly MAX_RETRIES_CAP = 5;

  /** Register a workflow definition. Caps maxRetries per step to 5. */
  registerWorkflow(def: WorkflowDefinition): void {
    // Enforce maxRetries cap on all steps
    const sanitized: WorkflowDefinition = {
      ...def,
      steps: def.steps.map((step) => ({
        ...step,
        maxRetries: Math.min(step.maxRetries ?? 1, WorkflowEngine.MAX_RETRIES_CAP),
      })),
    };
    this.definitions.set(sanitized.id, sanitized);
  }

  /** Register all built-in workflows */
  registerBuiltins(): void {
    for (const def of BUILTIN_WORKFLOWS) {
      this.registerWorkflow(def);
    }
  }

  /** Get a workflow definition by ID */
  getDefinition(id: string): WorkflowDefinition | undefined {
    return this.definitions.get(id);
  }

  /** Get all registered definitions */
  getAllDefinitions(): WorkflowDefinition[] {
    return [...this.definitions.values()];
  }

  /** Remove a workflow definition. Returns false if not found or if active/paused instances use it. */
  removeDefinition(id: string): boolean {
    if (!this.definitions.has(id)) {
      return false;
    }
    // Prevent removal if any running or paused instances use this definition
    for (const inst of this.instances.values()) {
      if (inst.definitionId === id && (inst.status === "running" || inst.status === "paused")) {
        return false;
      }
    }
    return this.definitions.delete(id);
  }

  /**
   * Start a new workflow instance.
   * Returns the workflow instance ID, or null if at capacity.
   */
  async startWorkflow(
    definitionId: string,
    input: string,
    correlationId?: string,
  ): Promise<string | null> {
    const def = this.definitions.get(definitionId);
    if (!def) {
      return null;
    }

    if (this.instances.size >= this.config.maxConcurrent) {
      return null;
    }
    if (!this.delegateFn) {
      return null;
    }

    const workflowId = `wf_${randomUUID()}`;
    const instance: WorkflowInstance = {
      workflowId,
      definitionId,
      originalInput: input,
      currentStep: 0,
      retryCount: 0,
      stepJobIds: [],
      lastResult: null,
      startedAt: new Date().toISOString(),
      status: "running",
    };

    this.instances.set(workflowId, instance);

    await this.publishWorkflowEvent("workflow_started", {
      workflow_id: workflowId,
      definition_id: definitionId,
      definition_name: def.name,
      total_steps: def.steps.length,
      correlation_id: correlationId,
    });

    // Execute first step
    await this.executeCurrentStep(workflowId, correlationId);

    return workflowId;
  }

  /**
   * Advance workflow after a job completes or fails.
   * Called by the event handler when a job event is received.
   */
  async onJobEvent(
    jobId: string,
    status: "completed" | "failed",
    result: string | null,
    correlationId?: string,
  ): Promise<void> {
    // Find the workflow instance that owns this job
    const instance = this.findInstanceByJobId(jobId);
    if (!instance || instance.status !== "running") {
      return;
    }

    const def = this.definitions.get(instance.definitionId);
    if (!def) {
      return;
    }

    const currentStepDef = def.steps[instance.currentStep];
    if (!currentStepDef) {
      return;
    }

    instance.lastResult = result;

    // Check if the next step's trigger matches this outcome
    const nextStepIndex = instance.currentStep + 1;
    const nextStep = def.steps[nextStepIndex];

    if (!nextStep) {
      // No more steps — workflow complete
      instance.status = status === "completed" ? "completed" : "failed";

      await this.publishWorkflowEvent("workflow_completed", {
        workflow_id: instance.workflowId,
        definition_id: instance.definitionId,
        final_status: instance.status,
        steps_completed: instance.stepJobIds.length,
        correlation_id: correlationId,
      });
      this.removeInstance(instance.workflowId);
      return;
    }

    // Check trigger condition
    if (nextStep.triggerOn !== status) {
      // The step expects a different outcome — check for retry
      const maxRetries = currentStepDef.maxRetries ?? 1;
      if (status === "failed" && instance.retryCount < maxRetries) {
        instance.retryCount++;
        await this.executeCurrentStep(instance.workflowId, correlationId);
        return;
      }

      // No more retries — workflow failed at this step
      instance.status = "failed";

      await this.publishWorkflowEvent("workflow_failed", {
        workflow_id: instance.workflowId,
        definition_id: instance.definitionId,
        final_status: "failed",
        failed_at_step: instance.currentStep,
        agent_id: currentStepDef.agentId,
        last_error: result,
        correlation_id: correlationId,
      });
      this.removeInstance(instance.workflowId);
      return;
    }

    // Advance to next step
    instance.currentStep = nextStepIndex;
    instance.retryCount = 0;

    // Check max depth
    const maxDepth = def.maxDepth ?? 10;
    if (instance.stepJobIds.length >= maxDepth) {
      instance.status = "failed";

      await this.publishWorkflowEvent("workflow_failed", {
        workflow_id: instance.workflowId,
        definition_id: instance.definitionId,
        final_status: "failed",
        reason: "max_depth_exceeded",
        depth: instance.stepJobIds.length,
        correlation_id: correlationId,
      });
      this.removeInstance(instance.workflowId);
      return;
    }

    // Check approval gate
    if (nextStep.requireApproval) {
      instance.status = "paused";
      await this.publishWorkflowEvent("workflow_paused", {
        workflow_id: instance.workflowId,
        definition_id: instance.definitionId,
        paused_at_step: nextStepIndex,
        agent_id: nextStep.agentId,
        reason: "approval_required",
        correlation_id: correlationId,
      });
      return;
    }

    await this.executeCurrentStep(instance.workflowId, correlationId);
  }

  /**
   * Resume a paused workflow (after human approval).
   */
  async resumeWorkflow(workflowId: string, correlationId?: string): Promise<boolean> {
    const instance = this.instances.get(workflowId);
    if (!instance || instance.status !== "paused") {
      return false;
    }

    instance.status = "running";
    await this.executeCurrentStep(workflowId, correlationId);
    return true;
  }

  /** Get a workflow instance by ID */
  getInstance(workflowId: string): WorkflowInstance | undefined {
    return this.instances.get(workflowId);
  }

  /** Get all active workflow instances */
  getActiveInstances(): WorkflowInstance[] {
    return [...this.instances.values()];
  }

  /**
   * Reap stale workflow instances (e.g., paused and never resumed).
   * Should be called periodically (e.g., every 10 minutes) to prevent memory leaks.
   * @param maxAgeMs - Maximum age in milliseconds before reaping (default: 1 hour)
   */
  reapStaleInstances(maxAgeMs = 3_600_000): number {
    const cutoff = Date.now() - maxAgeMs;
    let reaped = 0;
    for (const [id, inst] of this.instances) {
      if (new Date(inst.startedAt).getTime() < cutoff) {
        this.removeInstance(id);
        reaped++;
      }
    }
    return reaped;
  }

  /** Cancel a workflow instance by ID. Publishes event before cleanup. */
  async cancelWorkflow(workflowId: string): Promise<boolean> {
    const instance = this.instances.get(workflowId);
    if (!instance) {
      return false;
    }

    instance.status = "failed";
    await this.publishWorkflowEvent("workflow_cancelled", {
      workflow_id: workflowId,
      definition_id: instance.definitionId,
    });
    return this.removeInstance(workflowId);
  }

  /** Release all internal state. Call during shutdown to help GC. */
  dispose(): void {
    this.instances.clear();
    this.jobIndex.clear();
    this.definitions.clear();
    this.delegateFn = null;
    this.eventRelay = null;
  }

  /** Get engine stats */
  getStats(): {
    definitions: number;
    activeInstances: number;
    maxConcurrent: number;
  } {
    return {
      definitions: this.definitions.size,
      activeInstances: this.instances.size,
      maxConcurrent: this.config.maxConcurrent,
    };
  }

  // ─── Private ───

  /** Remove a workflow instance and clean up its job index entries. */
  private removeInstance(workflowId: string): boolean {
    const instance = this.instances.get(workflowId);
    if (!instance) {
      return false;
    }
    for (const jid of instance.stepJobIds) {
      this.jobIndex.delete(jid);
    }
    return this.instances.delete(workflowId);
  }

  private findInstanceByJobId(jobId: string): WorkflowInstance | undefined {
    const workflowId = this.jobIndex.get(jobId);
    if (!workflowId) {
      return undefined;
    }
    return this.instances.get(workflowId);
  }

  private async executeCurrentStep(workflowId: string, correlationId?: string): Promise<void> {
    const instance = this.instances.get(workflowId);
    if (!instance || !this.delegateFn) {
      return;
    }

    const def = this.definitions.get(instance.definitionId);
    if (!def) {
      return;
    }

    const step = def.steps[instance.currentStep];
    if (!step) {
      return;
    }

    // Build input based on contextFrom
    let question: string;
    switch (step.contextFrom) {
      case "previous_result":
        question = instance.lastResult || instance.originalInput;
        break;
      case "both":
        question = [
          `原始需求：${instance.originalInput}`,
          instance.lastResult ? `上一步結果：${instance.lastResult}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        break;
      case "original_input":
      default:
        question = instance.originalInput;
        break;
    }

    let result: Awaited<ReturnType<NonNullable<typeof this.delegateFn>>> | null = null;
    try {
      result = await this.delegateFn({
        agentId: step.agentId,
        question,
        source: `workflow:${instance.definitionId}`,
        correlationId,
      });
    } catch (err) {
      instance.status = "failed";
      await this.publishWorkflowEvent("workflow_failed", {
        workflow_id: workflowId,
        definition_id: instance.definitionId,
        final_status: "failed",
        reason: "delegation_error",
        error: err instanceof Error ? err.message : String(err),
        correlation_id: correlationId,
      });
      this.removeInstance(workflowId);
      return;
    }

    if (result) {
      instance.stepJobIds.push(result.jobId);
      this.jobIndex.set(result.jobId, workflowId);

      await this.publishWorkflowEvent("workflow_step_started", {
        workflow_id: workflowId,
        definition_id: instance.definitionId,
        step_index: instance.currentStep,
        agent_id: step.agentId,
        job_id: result.jobId,
        retry_count: instance.retryCount,
        correlation_id: correlationId,
      });
    } else {
      // Delegation failed — mark workflow as failed
      instance.status = "failed";

      await this.publishWorkflowEvent("workflow_failed", {
        workflow_id: workflowId,
        definition_id: instance.definitionId,
        final_status: "failed",
        reason: "delegation_failed",
        step_index: instance.currentStep,
        agent_id: step.agentId,
        correlation_id: correlationId,
      });
      this.removeInstance(workflowId);
    }
  }

  private async publishWorkflowEvent(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.eventRelay) {
      return;
    }
    const event: RelayEvent = {
      type,
      payload,
      timestamp: new Date().toISOString(),
    };
    await this.eventRelay.publish("workflow", event);
  }
}
