/**
 * gstack HTTP Request Stages — Mounts delegate/tasks/events routes into the gateway
 *
 * Usage in server-http.ts:
 *   import { buildGstackRequestStages } from "./gstack-http-stages.js";
 *   requestStages.push(...buildGstackRequestStages({ req, res, ... }));
 *
 * This module provides the bridge between the gateway's requestStages pattern
 * and the standalone handler modules (delegate-http, event-relay).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getMicrocompactMetrics } from "../agents/microcompact.js";
import type { ConversationMemoryService } from "../memory/conversation-memory.js";
import type { TaskTrackerService } from "../memory/task-tracker.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { handleDelegateHttpRequest, type DelegateHttpOptions } from "./delegate-http.js";
import type { EventRelayService } from "./event-relay.js";
import { safeTokenEqual } from "./http-common.js";
import { getCircuitBreakerStats } from "./leader-agent.js";
import { handleMetricsAlert } from "./metrics-alert-handler.js";
import type { WorkflowEngine } from "./workflow-chain.js";

// ─── Types ───

export type GstackHttpStagesConfig = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  taskTracker: TaskTrackerService;
  eventRelay: EventRelayService;
  memory?: ConversationMemoryService;
  workflowEngine?: WorkflowEngine;
};

type RequestStage = {
  name: string;
  run: () => Promise<boolean> | boolean;
};

// ─── Stage Builder ───

/**
 * Build request stages for gstack endpoints: /delegate, /tasks/*, /events.
 * Returns stages compatible with the gateway's runGatewayHttpRequestStages pattern.
 */
export function buildGstackRequestStages(
  req: IncomingMessage,
  res: ServerResponse,
  config: GstackHttpStagesConfig,
): RequestStage[] {
  const delegateOpts: DelegateHttpOptions = {
    auth: config.auth,
    trustedProxies: config.trustedProxies,
    taskTracker: config.taskTracker,
    eventRelay: config.eventRelay,
    memory: config.memory,
    workflowEngine: config.workflowEngine,
  };

  return [
    {
      name: "gstack-metrics",
      run: () => handleMetricsRequest(req, res, config),
    },
    {
      name: "gstack-delegate",
      run: () => handleDelegateHttpRequest(req, res, delegateOpts),
    },
    {
      name: "gstack-events-ticket",
      run: () => config.eventRelay.handleTicketRequest(req, res),
    },
    {
      name: "gstack-events",
      run: () => config.eventRelay.handleSseRequest(req, res),
    },
  ];
}

// ─── GET /metrics — Unified observability endpoint ───

async function handleMetricsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: GstackHttpStagesConfig,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/metrics") {
    return false;
  }
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }

  // Require authentication (timing-safe comparison to prevent timing attacks)
  const serviceToken = req.headers["x-service-token"] as string | undefined;
  const expectedToken = process.env.MCP_SERVICE_TOKEN;
  if (!serviceToken || !expectedToken || !safeTokenEqual(serviceToken, expectedToken)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return true;
  }

  const [memoryStats, taskStats, relayStats] = await Promise.all([
    config.memory?.getStats().catch(() => null) ?? null,
    Promise.resolve(config.taskTracker.getStats()),
    Promise.resolve(config.eventRelay.getStats()),
  ]);

  const workflowStats = config.workflowEngine?.getStats() ?? null;

  // Memory health alerts
  const alerts: string[] = [];
  const MEMORY_WARN_MB = parseFloat(process.env.REDIS_MEMORY_WARN_MB || "256");
  if (memoryStats?.memoryUsed) {
    const usedMb = parseMemoryUsed(memoryStats.memoryUsed);
    if (usedMb > MEMORY_WARN_MB) {
      alerts.push(
        `redis_memory_high: ${memoryStats.memoryUsed} exceeds ${MEMORY_WARN_MB}MB threshold`,
      );
    }
  }
  if (memoryStats && memoryStats.saveTurnTotal > 0) {
    const errorRate = memoryStats.saveTurnErrors / memoryStats.saveTurnTotal;
    if (errorRate > 0.05) {
      alerts.push(`memory_error_rate_high: ${(errorRate * 100).toFixed(1)}% save errors`);
    }
  }
  // Circuit breaker alerts
  const cbStats = getCircuitBreakerStats();
  for (const [agentId, cb] of Object.entries(cbStats)) {
    if (cb.state === "open") {
      alerts.push(`circuit_open: agent "${agentId}" circuit breaker is OPEN`);
    }
  }

  // Publish alerts via EventRelay + Telegram (fire-and-forget)
  if (alerts.length > 0) {
    config.eventRelay
      .publish("all", {
        type: "metrics_alert",
        payload: { alerts },
        timestamp: new Date().toISOString(),
      })
      .catch(() => {});
    void handleMetricsAlert({ alerts });
  }

  const body = {
    timestamp: new Date().toISOString(),
    memory: memoryStats,
    tasks: taskStats,
    events: relayStats,
    workflow: workflowStats,
    microcompact: getMicrocompactMetrics(),
    circuitBreakers: cbStats,
    alerts,
  };

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
  return true;
}

/** Parse Redis used_memory_human string (e.g., "1.50M", "256.00K", "2.10G") to MB. */
function parseMemoryUsed(human: string): number {
  const match = human.match(/^([\d.]+)([BKMGT])/i);
  if (!match) {
    return 0;
  }
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1 / 1048576,
    K: 1 / 1024,
    M: 1,
    G: 1024,
    T: 1048576,
  };
  return value * (multipliers[unit] ?? 0);
}
