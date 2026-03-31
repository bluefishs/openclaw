/**
 * Agent Delegation Handler — POST /delegate
 *
 * Accepts async task delegation from NemoClaw (or other CK_ services).
 * Creates a job via TaskTracker, returns 202 Accepted with job_id immediately,
 * then processes in the background. On completion, publishes result via EventRelay.
 *
 * Flow:
 *   NemoClaw → POST /delegate → 202 { job_id }
 *                                  ↓ (background)
 *                              agentCommand()
 *                                  ↓
 *                              TaskTracker.markCompleted()
 *                              EventRelay.publish("jobs", ...)
 *                                  ↓
 *   NemoClaw ← GET /tasks/{id} OR ← SSE /events?channel=jobs
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import type { ConversationMemoryService } from "../memory/conversation-memory.js";
import type { TaskTrackerService } from "../memory/task-tracker.js";
import { defaultRuntime } from "../runtime.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayConnect } from "./auth.js";
import { getCorrelationId } from "./correlation.js";
import type { EventRelayService } from "./event-relay.js";
import {
  readJsonBodyOrError,
  safeTokenEqual,
  sendJson,
  sendMethodNotAllowed,
} from "./http-common.js";
import { getBearerToken, getHeader } from "./http-utils.js";
import { SAFE_AGENT_ID_RE } from "./leader-agent.js";
import type { WorkflowEngine } from "./workflow-chain.js";

// ─── Delegate rate limiting ───

/** Max /delegate requests per source per DELEGATE_RATE_WINDOW_MS */
const DELEGATE_RATE_LIMIT = 30;
/** Rate limit window in ms (1 minute) */
const DELEGATE_RATE_WINDOW_MS = 60_000;
/** Max tracked sources to prevent memory exhaustion */
const MAX_DELEGATE_SOURCES = 500;

const delegateSourceTimes = new Map<string, number[]>();

function isDelegateRateLimited(source: string): boolean {
  const now = Date.now();
  const cutoff = now - DELEGATE_RATE_WINDOW_MS;
  let times = delegateSourceTimes.get(source);

  if (times) {
    while (times.length > 0 && times[0] <= cutoff) {
      times.shift();
    }
    if (times.length === 0) {
      delegateSourceTimes.delete(source);
      times = undefined;
    }
  }

  if (times && times.length >= DELEGATE_RATE_LIMIT) {
    return true;
  }

  if (!times) {
    if (delegateSourceTimes.size >= MAX_DELEGATE_SOURCES) {
      // Evict empty entries
      for (const [key, vals] of delegateSourceTimes) {
        if (vals.length === 0) {
          delegateSourceTimes.delete(key);
        }
      }
    }
    times = [];
    delegateSourceTimes.set(source, times);
  }
  times.push(now);
  return false;
}

// ─── Types ───

export type DelegateHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  taskTracker: TaskTrackerService;
  eventRelay: EventRelayService;
  memory?: ConversationMemoryService;
  /** Optional: WorkflowEngine for automatic agent chaining */
  workflowEngine?: WorkflowEngine;
};

type DelegateRequestBody = {
  agent_id: string;
  payload: {
    question: string;
    context?: Record<string, unknown>;
  };
  source?: string;
  session_id?: string;
  priority?: string;
};

// ─── Authentication (same dual-mode as /reason) ───

async function authenticateDelegate(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DelegateHttpOptions,
): Promise<boolean> {
  const serviceToken = getHeader(req, "x-service-token");
  const expectedToken = process.env.MCP_SERVICE_TOKEN;

  if (serviceToken) {
    if (expectedToken && safeTokenEqual(serviceToken, expectedToken)) {
      return true;
    }
    sendJson(res, 401, {
      success: false,
      error: { code: "AUTH_FAILED", message: "Invalid service token" },
    });
    return false;
  }

  const token = getBearerToken(req);
  const authResult = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: { token, password: token },
    req,
    trustedProxies: opts.trustedProxies,
  });
  if (!authResult.ok) {
    sendJson(res, 401, {
      success: false,
      error: { code: "AUTH_FAILED", message: authResult.reason ?? "Unauthorized" },
    });
    return false;
  }
  return true;
}

// ─── Handler ───

export async function handleDelegateHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DelegateHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

  // ── POST /tasks/{job_id}/approve — human approval gate ──
  const approveMatch = url.pathname.match(/^\/tasks\/([a-zA-Z0-9_\-.:]+)\/approve$/);
  if (approveMatch) {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res);
      return true;
    }
    const authOk = await authenticateDelegate(req, res, opts);
    if (!authOk) {
      return true;
    }

    const jobId = approveMatch[1];
    const rawBody = await readJsonBodyOrError(req, res, 4096);
    if (rawBody === undefined) {
      return true;
    }

    const body = rawBody as { approved_by?: string };
    const approvedBy = body.approved_by || "anonymous";

    const ok = await opts.taskTracker.approve(jobId, approvedBy);
    if (!ok) {
      const job = await opts.taskTracker.getJob(jobId);
      const reason = !job
        ? "not found or expired"
        : `not in pending_approval state (current: ${job.status})`;
      sendJson(res, 409, {
        success: false,
        error: { code: "INVALID_STATE", message: `Cannot approve job ${jobId}: ${reason}` },
      });
      return true;
    }

    await opts.eventRelay.publish("jobs", {
      type: "job_approved",
      payload: { job_id: jobId, approved_by: approvedBy },
      timestamp: new Date().toISOString(),
    });

    sendJson(res, 200, {
      success: true,
      job_id: jobId,
      status: "approved",
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  // ── POST /tasks/{job_id}/reject — human rejection gate ──
  const rejectMatch = url.pathname.match(/^\/tasks\/([a-zA-Z0-9_\-.:]+)\/reject$/);
  if (rejectMatch) {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res);
      return true;
    }
    const authOk = await authenticateDelegate(req, res, opts);
    if (!authOk) {
      return true;
    }

    const jobId = rejectMatch[1];
    const rawBody = await readJsonBodyOrError(req, res, 4096);
    if (rawBody === undefined) {
      return true;
    }

    const body = rawBody as { rejected_by?: string; reason?: string };
    const rejectedBy = body.rejected_by || "anonymous";
    const reason = body.reason || "";

    const ok = await opts.taskTracker.reject(jobId, rejectedBy, reason);
    if (!ok) {
      const job = await opts.taskTracker.getJob(jobId);
      const msg = !job
        ? "not found or expired"
        : `not in pending_approval state (current: ${job.status})`;
      sendJson(res, 409, {
        success: false,
        error: { code: "INVALID_STATE", message: `Cannot reject job ${jobId}: ${msg}` },
      });
      return true;
    }

    await opts.eventRelay.publish("jobs", {
      type: "job_rejected",
      payload: { job_id: jobId, rejected_by: rejectedBy, reason },
      timestamp: new Date().toISOString(),
    });

    sendJson(res, 200, {
      success: true,
      job_id: jobId,
      status: "rejected",
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  // ── POST /workflows/{workflow_id}/resume — resume a paused workflow ──
  const resumeMatch = url.pathname.match(/^\/workflows\/([a-zA-Z0-9_\-.:]+)\/resume$/);
  if (resumeMatch) {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res);
      return true;
    }
    const authOk = await authenticateDelegate(req, res, opts);
    if (!authOk) {
      return true;
    }

    if (!opts.workflowEngine) {
      sendJson(res, 503, {
        success: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "WorkflowEngine not configured" },
      });
      return true;
    }

    const workflowId = resumeMatch[1];
    const ok = await opts.workflowEngine.resumeWorkflow(workflowId);
    if (!ok) {
      sendJson(res, 409, {
        success: false,
        error: {
          code: "INVALID_STATE",
          message: `Cannot resume workflow ${workflowId}: not paused or not found`,
        },
      });
      return true;
    }

    sendJson(res, 200, {
      success: true,
      workflow_id: workflowId,
      status: "resumed",
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  // ── /workflows/definitions — CRUD for workflow definitions ──
  if (url.pathname === "/workflows/definitions") {
    if (req.method !== "GET" && req.method !== "POST") {
      sendMethodNotAllowed(res, "GET, POST");
      return true;
    }
    const authOk = await authenticateDelegate(req, res, opts);
    if (!authOk) {
      return true;
    }

    if (!opts.workflowEngine) {
      sendJson(res, 503, {
        success: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "WorkflowEngine not configured" },
      });
      return true;
    }

    if (req.method === "GET") {
      const defs = opts.workflowEngine.getAllDefinitions().map((d) => ({
        id: d.id,
        name: d.name,
        stepCount: d.steps.length,
      }));
      sendJson(res, 200, { success: true, definitions: defs, timestamp: new Date().toISOString() });
      return true;
    }

    // POST — register a new workflow definition
    const bodyResult = await readJsonBodyOrError(req, res, 64 * 1024);
    if (!bodyResult) {
      return true;
    } // error already sent
    const body = bodyResult as Record<string, unknown>;

    if (!body.id || typeof body.id !== "string" || !body.name || typeof body.name !== "string") {
      sendJson(res, 400, {
        success: false,
        error: { code: "INVALID_SCHEMA", message: "`id` and `name` are required strings" },
      });
      return true;
    }
    if (!Array.isArray(body.steps) || body.steps.length === 0) {
      sendJson(res, 400, {
        success: false,
        error: { code: "INVALID_SCHEMA", message: "`steps` must be a non-empty array" },
      });
      return true;
    }
    if (!SAFE_AGENT_ID_RE.test(body.id)) {
      sendJson(res, 400, {
        success: false,
        error: { code: "INVALID_SCHEMA", message: "`id` contains invalid characters" },
      });
      return true;
    }

    // Validate each step
    const validTriggers = new Set(["completed", "failed"]);
    const validContextFrom = new Set(["previous_result", "original_input", "both"]);
    for (let i = 0; i < (body.steps as unknown[]).length; i++) {
      const step = (body.steps as Record<string, unknown>[])[i];
      if (
        !step.agentId ||
        typeof step.agentId !== "string" ||
        !SAFE_AGENT_ID_RE.test(step.agentId)
      ) {
        sendJson(res, 400, {
          success: false,
          error: { code: "INVALID_SCHEMA", message: `steps[${i}].agentId is missing or invalid` },
        });
        return true;
      }
      if (!validTriggers.has(step.triggerOn as string)) {
        sendJson(res, 400, {
          success: false,
          error: {
            code: "INVALID_SCHEMA",
            message: `steps[${i}].triggerOn must be "completed" or "failed"`,
          },
        });
        return true;
      }
      if (!validContextFrom.has(step.contextFrom as string)) {
        sendJson(res, 400, {
          success: false,
          error: {
            code: "INVALID_SCHEMA",
            message: `steps[${i}].contextFrom must be "previous_result", "original_input", or "both"`,
          },
        });
        return true;
      }
    }

    // Prevent overwriting existing definitions
    if (opts.workflowEngine.getDefinition(body.id)) {
      sendJson(res, 409, {
        success: false,
        error: {
          code: "CONFLICT",
          message: `Definition "${body.id}" already exists. Use DELETE first to replace.`,
        },
      });
      return true;
    }

    opts.workflowEngine.registerWorkflow(
      body as {
        id: string;
        name: string;
        steps: Array<{
          agentId: string;
          triggerOn: "completed" | "failed";
          contextFrom: "previous_result" | "original_input" | "both";
        }>;
        maxDepth?: number;
      },
    );
    sendJson(res, 201, {
      success: true,
      definition_id: body.id,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  // ── DELETE /workflows/definitions/{def_id} — remove a workflow definition ──
  const defDeleteMatch = url.pathname.match(/^\/workflows\/definitions\/([a-zA-Z0-9_\-.:]+)$/);
  if (defDeleteMatch) {
    if (req.method !== "DELETE") {
      sendMethodNotAllowed(res, "DELETE");
      return true;
    }
    const authOk = await authenticateDelegate(req, res, opts);
    if (!authOk) {
      return true;
    }

    if (!opts.workflowEngine) {
      sendJson(res, 503, {
        success: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "WorkflowEngine not configured" },
      });
      return true;
    }

    const defId = defDeleteMatch[1];
    const ok = opts.workflowEngine.removeDefinition(defId);
    if (!ok) {
      sendJson(res, 409, {
        success: false,
        error: {
          code: "CONFLICT",
          message: `Definition ${defId} not found or has active instances`,
        },
      });
      return true;
    }

    sendJson(res, 200, {
      success: true,
      definition_id: defId,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  // ── DELETE /workflows/{workflow_id} — cancel a running/paused workflow ──
  const cancelMatch = url.pathname.match(/^\/workflows\/([a-zA-Z0-9_\-.:]+)$/);
  if (cancelMatch) {
    if (req.method !== "DELETE") {
      sendMethodNotAllowed(res, "DELETE");
      return true;
    }
    const authOk = await authenticateDelegate(req, res, opts);
    if (!authOk) {
      return true;
    }

    if (!opts.workflowEngine) {
      sendJson(res, 503, {
        success: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "WorkflowEngine not configured" },
      });
      return true;
    }

    const workflowId = cancelMatch[1];
    const ok = await opts.workflowEngine.cancelWorkflow(workflowId);
    if (!ok) {
      sendJson(res, 404, {
        success: false,
        error: { code: "NOT_FOUND", message: `Workflow ${workflowId} not found` },
      });
      return true;
    }

    sendJson(res, 200, {
      success: true,
      workflow_id: workflowId,
      status: "cancelled",
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  // ── GET /tasks/{job_id} — job status polling ──
  const taskMatch = url.pathname.match(/^\/tasks\/([a-zA-Z0-9_\-.:]+)$/);
  if (taskMatch) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }
    const authOk = await authenticateDelegate(req, res, opts);
    if (!authOk) {
      return true;
    }

    const jobId = taskMatch[1];
    const job = await opts.taskTracker.getJob(jobId);
    if (!job) {
      sendJson(res, 404, {
        success: false,
        error: { code: "NOT_FOUND", message: `Job ${jobId} not found or expired` },
      });
      return true;
    }

    sendJson(res, 200, {
      success: true,
      job,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  // ── POST /delegate — submit async task ──
  if (url.pathname !== "/delegate") {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  const authOk = await authenticateDelegate(req, res, opts);
  if (!authOk) {
    return true;
  }

  // Per-source rate limiting (IP-based)
  const delegateSource =
    getHeader(req, "x-forwarded-for")?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";
  if (isDelegateRateLimited(delegateSource)) {
    sendJson(res, 429, {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: `Rate limit exceeded (${DELEGATE_RATE_LIMIT} requests per ${DELEGATE_RATE_WINDOW_MS / 1000}s)`,
      },
    });
    return true;
  }

  const rawBody = await readJsonBodyOrError(req, res, 512 * 1024);
  if (rawBody === undefined) {
    return true;
  }

  const body = rawBody as Partial<DelegateRequestBody>;

  // Validate
  if (!body.agent_id || typeof body.agent_id !== "string") {
    sendJson(res, 400, {
      success: false,
      error: { code: "INVALID_SCHEMA", message: "Missing `agent_id`" },
    });
    return true;
  }
  if (!SAFE_AGENT_ID_RE.test(body.agent_id)) {
    sendJson(res, 400, {
      success: false,
      error: { code: "INVALID_SCHEMA", message: "`agent_id` contains invalid characters" },
    });
    return true;
  }
  if (!body.payload?.question || typeof body.payload.question !== "string") {
    sendJson(res, 400, {
      success: false,
      error: { code: "INVALID_SCHEMA", message: "Missing `payload.question`" },
    });
    return true;
  }
  if (body.payload.question.length > 32_000) {
    sendJson(res, 400, {
      success: false,
      error: { code: "INVALID_SCHEMA", message: "`payload.question` too long" },
    });
    return true;
  }

  const correlationId = getCorrelationId(req) ?? randomUUID();
  const jobId = `dlg_${randomUUID()}`;
  const source = body.source || "unknown";
  const question = body.payload.question.trim();

  // Create job
  const created = await opts.taskTracker.createJob({
    jobId,
    agentId: body.agent_id,
    input: question,
    source,
    correlationId,
  });

  if (!created) {
    sendJson(res, 503, {
      success: false,
      error: {
        code: "CAPACITY_EXCEEDED",
        message: "Task tracker at capacity or unavailable. Retry later.",
      },
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  // Publish job_created event so LiveActivityFeed can show it immediately
  await opts.eventRelay.publish("jobs", {
    type: "job_created",
    payload: { job_id: jobId, agent_id: body.agent_id, source },
    timestamp: new Date().toISOString(),
  });

  // Respond immediately with 202 Accepted
  sendJson(res, 202, {
    success: true,
    job_id: jobId,
    status: "pending",
    poll_url: `/tasks/${jobId}`,
    events_url: `/events?channel=jobs`,
    correlation_id: correlationId,
    timestamp: new Date().toISOString(),
  });

  // ── Background processing (fire-and-forget) ──
  void (async () => {
    try {
      await opts.taskTracker.markRunning(jobId);

      // Publish job_running event
      await opts.eventRelay.publish("jobs", {
        type: "job_running",
        payload: { job_id: jobId, agent_id: body.agent_id, source },
        timestamp: new Date().toISOString(),
      });

      // Load conversation memory if session_id provided
      const memory = opts.memory;
      const hasSessionId = !!body.session_id;
      const sessionId = body.session_id || randomUUID();
      const memKey = memory && hasSessionId ? memory.buildKey(body.agent_id!, sessionId) : null;
      const history = memKey ? await memory!.loadContext(memKey) : [];
      const historyPrompt = memory ? memory.formatForPrompt(history) : "";

      const contextParts: string[] = [];
      if (historyPrompt) {
        contextParts.push(historyPrompt);
      }
      if (body.payload?.context) {
        contextParts.push(`Context from ${body.agent_id}: ${JSON.stringify(body.payload.context)}`);
      }
      const extraSystemPrompt = contextParts.length > 0 ? contextParts.join("\n\n") : undefined;

      const sessionKey = `delegate:${body.agent_id}:${sessionId}`;
      const deps = createDefaultDeps();
      const result = await agentCommand(
        {
          message: question,
          extraSystemPrompt,
          sessionKey,
          runId: jobId,
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

      // Save to memory
      if (memKey && answer) {
        memory!.saveTurn(memKey, question, answer).catch(() => {});
      }

      // Mark completed
      await opts.taskTracker.markCompleted(jobId, JSON.stringify({ answer }));

      // Publish event
      await opts.eventRelay.publish("jobs", {
        type: "job_completed",
        payload: { job_id: jobId, agent_id: body.agent_id, source, answer_length: answer.length },
        correlation_id: correlationId,
        timestamp: new Date().toISOString(),
      });

      // Advance workflow chain if this job belongs to one
      if (opts.workflowEngine) {
        opts.workflowEngine
          .onJobEvent(jobId, "completed", answer, correlationId)
          .catch((e) => console.warn(`[delegate] workflow advance failed: ${e}`));
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[delegate] job ${jobId} corr=${correlationId} failed:`, err);

      try {
        await opts.taskTracker.markFailed(jobId, errorMsg);
        await opts.eventRelay.publish("jobs", {
          type: "job_failed",
          payload: { job_id: jobId, agent_id: body.agent_id, source, error: errorMsg },
          correlation_id: correlationId,
          timestamp: new Date().toISOString(),
        });
      } catch (cleanupErr) {
        console.error(`[delegate] job ${jobId} cleanup also failed:`, cleanupErr);
      }

      // Advance workflow chain on failure (may trigger retry or fail the workflow)
      if (opts.workflowEngine) {
        opts.workflowEngine
          .onJobEvent(jobId, "failed", errorMsg, correlationId)
          .catch((e) => console.warn(`[delegate] workflow fail-advance failed: ${e}`));
      }
    }
  })().catch((e) => {
    console.error(`[delegate] unhandled background error for job ${jobId}:`, e);
  });

  return true;
}
