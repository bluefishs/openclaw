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
import type { ConversationMemoryService } from "../memory/conversation-memory.js";
import type { TaskTrackerService } from "../memory/task-tracker.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { handleDelegateHttpRequest, type DelegateHttpOptions } from "./delegate-http.js";
import type { EventRelayService } from "./event-relay.js";
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
