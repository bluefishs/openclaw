/**
 * gstack Bootstrap — Wires gstack roles, WorkflowEngine, and periodic reap
 *
 * Call `bootstrapGstack()` during gateway startup to:
 *   1. Register gstack cognitive roles into the default AgentRegistry
 *   2. Initialize WorkflowEngine with built-in + gstack workflows
 *   3. Start periodic reap timer for stale workflow instances
 *
 * Call `shutdownGstack()` during gateway shutdown to clean up timers.
 */

import type { TaskTrackerService } from "../memory/task-tracker.js";
import type { EventRelayService } from "./event-relay.js";
import { registerGstackRoles, unregisterGstackRoles } from "./gstack-roles.js";
import { getDefaultRegistry, type AgentRegistry } from "./leader-agent.js";
import { WorkflowEngine, type DelegateFunction } from "./workflow-chain.js";

// ─── Types ───

export type GstackBootstrapOptions = {
  /** EventRelay for publishing workflow events */
  eventRelay: EventRelayService;
  /** Delegate function for creating sub-tasks */
  delegateFn: DelegateFunction;
  /** Max concurrent workflow instances (default: 10) */
  maxConcurrentWorkflows?: number;
  /** Reap interval in ms (default: 600_000 = 10 min) */
  reapIntervalMs?: number;
  /** Max age for stale instances in ms (default: 3_600_000 = 1 hour) */
  reapMaxAgeMs?: number;
  /** TaskTracker for periodic runningCount reconciliation (optional) */
  taskTracker?: TaskTrackerService;
  /** Reconcile interval in ms (default: 300_000 = 5 min) */
  reconcileIntervalMs?: number;
};

export type GstackBootstrapResult = {
  workflowEngine: WorkflowEngine;
  gstackRolesRegistered: number;
};

// ─── Module State ───

let reapTimer: ReturnType<typeof setInterval> | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let activeEngine: WorkflowEngine | null = null;
let activeRegistry: AgentRegistry | null = null;

// ─── Bootstrap ───

/**
 * Initialize gstack integration. Idempotent — calling twice cleans up the first.
 */
export function bootstrapGstack(opts: GstackBootstrapOptions): GstackBootstrapResult {
  // Clean up previous bootstrap if any
  shutdownGstack();

  // 1. Register gstack roles into default registry (remember for shutdown)
  const registry = getDefaultRegistry();
  activeRegistry = registry;
  const gstackRolesRegistered = registerGstackRoles(registry);

  // 2. Initialize WorkflowEngine
  const engine = new WorkflowEngine({
    maxConcurrent: opts.maxConcurrentWorkflows ?? 10,
  });
  engine.setEventRelay(opts.eventRelay);
  engine.setDelegateFn(opts.delegateFn);
  engine.registerBuiltins();

  // 3. Start periodic reap
  const reapIntervalMs = opts.reapIntervalMs ?? 600_000;
  const reapMaxAgeMs = opts.reapMaxAgeMs ?? 3_600_000;

  reapTimer = setInterval(() => {
    try {
      const reaped = engine.reapStaleInstances(reapMaxAgeMs);
      if (reaped > 0) {
        console.log(`[gstack-bootstrap] Reaped ${reaped} stale workflow instance(s)`);
      }
    } catch (err) {
      console.error(`[gstack-bootstrap] Reap timer failed: ${String(err)}`);
    }
  }, reapIntervalMs);

  // Prevent timer from keeping the process alive
  if (reapTimer.unref) {
    reapTimer.unref();
  }

  // 4. Start periodic TaskTracker reconciliation (if provided)
  if (opts.taskTracker) {
    const reconcileMs = opts.reconcileIntervalMs ?? 300_000;
    const tracker = opts.taskTracker;
    reconcileTimer = setInterval(() => {
      void tracker.reconcileRunningCount().catch((err: unknown) => {
        console.error(`[gstack-bootstrap] Reconcile failed: ${String(err)}`);
      });
    }, reconcileMs);
    if (reconcileTimer.unref) {
      reconcileTimer.unref();
    }
  }

  activeEngine = engine;

  console.log(
    `[gstack-bootstrap] Initialized: ${gstackRolesRegistered} gstack roles, ` +
      `${engine.getAllDefinitions().length} workflow definitions, ` +
      `reap every ${reapIntervalMs / 1000}s`,
  );

  return { workflowEngine: engine, gstackRolesRegistered };
}

// ─── Shutdown ───

/** Clean up timers, engine state, and unregister gstack roles. Safe to call multiple times. */
export function shutdownGstack(): void {
  if (reapTimer) {
    clearInterval(reapTimer);
    reapTimer = null;
  }
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  if (activeEngine) {
    activeEngine.dispose();
    activeEngine = null;
  }
  // Symmetric cleanup: unregister from the same registry used during bootstrap
  const registry = activeRegistry ?? getDefaultRegistry();
  activeRegistry = null;
  unregisterGstackRoles(registry);
}

/** Get the active WorkflowEngine (null if not bootstrapped). */
export function getActiveWorkflowEngine(): WorkflowEngine | null {
  return activeEngine;
}
