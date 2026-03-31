/**
 * Workflow SSE Controller — Connects to EventRelay /events?channel=workflow
 *
 * Manages SSE lifecycle and transforms raw events into WorkflowDashboardProps.
 * Auto-reconnects on disconnect with exponential backoff.
 */

import type { WorkflowEvent, WorkflowInstanceView } from "../views/workflow-dashboard.ts";

// ─── Types ───

export type WorkflowSseState = {
  connected: boolean;
  instances: Map<string, WorkflowInstanceView>;
  events: WorkflowEvent[];
};

export type WorkflowSseCallbacks = {
  onStateChange: (state: WorkflowSseState) => void;
};

// ─── Constants ───

const MAX_EVENTS = 100;
const MAX_INSTANCES = 50;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

// ─── Controller ───

export class WorkflowSseController {
  private eventSource: EventSource | null = null;
  private state: WorkflowSseState;
  private callbacks: WorkflowSseCallbacks;
  private baseUrl: string;
  private serviceToken: string;
  private reconnectMs = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(baseUrl: string, serviceToken: string, callbacks: WorkflowSseCallbacks) {
    this.baseUrl = baseUrl;
    this.serviceToken = serviceToken;
    this.callbacks = callbacks;
    this.state = {
      connected: false,
      instances: new Map(),
      events: [],
    };
  }

  /**
   * Start SSE connection.
   * Uses ticket exchange to avoid putting long-lived tokens in URL/logs:
   *   POST /events/ticket (with X-Service-Token header) → { ticket }
   *   GET /events?channel=workflow&ticket=xxx
   */
  async connect(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disconnect();

    const params = new URLSearchParams({ channel: "workflow" });

    // Attempt ticket exchange; fall back to legacy ?token= if it fails
    if (this.serviceToken) {
      try {
        const ticketRes = await fetch(`${this.baseUrl}/events/ticket`, {
          method: "POST",
          headers: { "X-Service-Token": this.serviceToken },
        });
        if (ticketRes.ok) {
          const { ticket } = (await ticketRes.json()) as { ticket: string };
          params.set("ticket", ticket);
        } else {
          // Ticket endpoint unavailable — legacy fallback
          params.set("token", this.serviceToken);
        }
      } catch {
        params.set("token", this.serviceToken);
      }
    }

    const url = `${this.baseUrl}/events?${params.toString()}`;
    this.eventSource = new EventSource(url);

    this.eventSource.addEventListener("open", () => {
      this.state.connected = true;
      this.reconnectMs = RECONNECT_BASE_MS;
      this.notify();
    });

    this.eventSource.addEventListener("message", (ev: MessageEvent) => {
      try {
        const event = JSON.parse(ev.data) as WorkflowEvent;
        this.handleEvent(event);
      } catch {
        // Ignore malformed events
      }
    });

    this.eventSource.addEventListener("error", () => {
      this.state.connected = false;
      this.notify();
      this.scheduleReconnect();
    });
  }

  /** Disconnect and stop reconnecting. */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.state.connected = false;
  }

  /** Permanently dispose — no reconnection. */
  dispose(): void {
    this.disposed = true;
    this.disconnect();
  }

  /** Get current state snapshot. */
  getState(): WorkflowSseState {
    return this.state;
  }

  /** Get instances as sorted array (active first, then recent). */
  getInstancesArray(): WorkflowInstanceView[] {
    const arr = [...this.state.instances.values()];
    const order: Record<string, number> = { running: 0, paused: 1, failed: 2, completed: 3 };
    return arr.toSorted((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  }

  // ─── Private ───

  private handleEvent(event: WorkflowEvent): void {
    // Add to event feed (most recent first)
    this.state.events.unshift(event);
    if (this.state.events.length > MAX_EVENTS) {
      this.state.events.length = MAX_EVENTS;
    }

    // Update instance state based on event type
    const p = event.payload;
    const wfId = p.workflow_id as string | undefined;
    if (!wfId) {
      this.notify();
      return;
    }

    switch (event.type) {
      case "workflow_started": {
        if (this.state.instances.size >= MAX_INSTANCES) {
          // Evict oldest completed/failed
          for (const [id, inst] of this.state.instances) {
            if (inst.status === "completed" || inst.status === "failed") {
              this.state.instances.delete(id);
              break;
            }
          }
        }
        this.state.instances.set(wfId, {
          workflowId: wfId,
          definitionId: (p.definition_id as string) ?? "",
          definitionName: (p.definition_name as string) ?? "",
          currentStep: 0,
          totalSteps: (p.total_steps as number) ?? 0,
          status: "running",
          startedAt: event.timestamp,
          lastEvent: null,
          stepAgents: Array.from<string>({ length: (p.total_steps as number) ?? 0 }).fill(""),
        });
        break;
      }

      case "workflow_step_started": {
        const inst = this.state.instances.get(wfId);
        if (inst) {
          const agentId = (p.agent_id as string) ?? "";
          inst.currentStep = ((p.step_index as number) ?? inst.currentStep) + 1;
          inst.lastEvent = `step:${inst.currentStep}:${agentId}`;
          // Track agent per step index for visualization
          const stepIdx = (p.step_index as number) ?? inst.stepAgents.length;
          inst.stepAgents[stepIdx] = agentId;
        }
        break;
      }

      case "workflow_completed": {
        const inst = this.state.instances.get(wfId);
        if (inst) {
          inst.status = "completed";
          inst.currentStep = inst.totalSteps;
          inst.lastEvent = "completed";
        }
        break;
      }

      case "workflow_failed": {
        const inst = this.state.instances.get(wfId);
        if (inst) {
          inst.status = "failed";
          const reason =
            typeof p.reason === "string"
              ? p.reason
              : typeof p.last_error === "string"
                ? p.last_error
                : "unknown";
          inst.lastEvent = `failed:${reason}`;
        }
        break;
      }

      case "workflow_paused": {
        const inst = this.state.instances.get(wfId);
        if (inst) {
          inst.status = "paused";
          inst.lastEvent = `paused:${typeof p.reason === "string" ? p.reason : "approval_required"}`;
        }
        break;
      }

      case "workflow_cancelled": {
        const inst = this.state.instances.get(wfId);
        if (inst) {
          inst.status = "failed";
          inst.lastEvent = "cancelled";
        }
        break;
      }
    }

    this.notify();
  }

  private notify(): void {
    // Shallow-clone state so Lit's @state() reactivity detects changes
    // (instances Map → new Map, events → new Array)
    this.callbacks.onStateChange({
      connected: this.state.connected,
      instances: new Map(this.state.instances),
      events: [...this.state.events],
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed) {
      return;
    }
    this.disconnect();

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.reconnectMs);

    // Exponential backoff with jitter
    this.reconnectMs = Math.min(this.reconnectMs * 2 + Math.random() * 500, RECONNECT_MAX_MS);
  }
}
