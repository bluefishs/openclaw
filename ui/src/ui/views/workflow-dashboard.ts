/**
 * Workflow Dashboard — Real-time visualization of WorkflowEngine chains
 *
 * Displays:
 *   - Active workflow instances with step progress
 *   - Recent workflow events (started/completed/failed/paused)
 *   - Workflow definition catalog
 *
 * Data source: EventRelay SSE channel "workflow" + polling /tasks/{id}
 */

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";

// ─── Types ───

export type WorkflowEvent = {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
};

export type WorkflowInstanceView = {
  workflowId: string;
  definitionId: string;
  definitionName: string;
  currentStep: number;
  totalSteps: number;
  status: "running" | "completed" | "failed" | "paused";
  startedAt: string;
  lastEvent: string | null;
  /** Agent IDs for each step, populated as step_started events arrive */
  stepAgents: string[];
};

export type WorkflowDashboardProps = {
  /** Active and recently completed workflow instances */
  instances: WorkflowInstanceView[];
  /** Recent workflow events from SSE */
  events: WorkflowEvent[];
  /** Available workflow definitions */
  definitions: Array<{ id: string; name: string; stepCount: number }>;
  /** Whether SSE connection is active */
  connected: boolean;
  /** Callback to resume a paused workflow */
  onResume?: (workflowId: string) => void;
  /** Callback to cancel a running workflow */
  onCancel?: (workflowId: string) => void;
  /** Callback to delete a workflow definition */
  onDeleteDefinition?: (definitionId: string) => void;
  /** Callback to export all definitions as JSON */
  onExportDefinitions?: () => void;
  /** Callback to import definitions from JSON string */
  onImportDefinitions?: (json: string) => void;
};

// ─── Helpers ───

function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return "\u25B6";
    case "completed":
      return "\u2713";
    case "failed":
      return "\u2717";
    case "paused":
      return "\u23F8";
    default:
      return "\u25CB";
  }
}

function statusClass(status: string): string {
  return `wf-status--${status}`;
}

/** Sanitize event type for use as CSS class suffix (alphanumeric + underscore only). */
function safeEventTypeClass(type: string): string {
  return type.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function progressBar(current: number, total: number): TemplateResult {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  return html`
    <div class="wf-progress" role="progressbar" aria-valuenow=${current} aria-valuemin=${0} aria-valuemax=${total} aria-label="${t("workflows.progress")}: ${current}/${total}">
      <div class="wf-progress__bar" style="width: ${pct}%"></div>
      <span class="wf-progress__label">${current}/${total}</span>
    </div>
  `;
}

/** Step status for visualization */
type StepVizStatus = "completed" | "active" | "pending" | "failed" | "paused";

function stepVizStatus(stepIdx: number, currentStep: number, wfStatus: string): StepVizStatus {
  if (stepIdx < currentStep) {
    return "completed";
  }
  if (stepIdx === currentStep) {
    if (wfStatus === "failed") {
      return "failed";
    }
    if (wfStatus === "paused") {
      return "paused";
    }
    if (wfStatus === "completed") {
      return "completed";
    }
    return "active";
  }
  return "pending";
}

function stepVizIcon(status: StepVizStatus): string {
  switch (status) {
    case "completed":
      return "\u2713";
    case "active":
      return "\u25B6";
    case "failed":
      return "\u2717";
    case "paused":
      return "\u23F8";
    case "pending":
      return "\u25CB";
  }
}

/** Render a step chain visualization: [agent1] → [agent2] → [agent3] */
function renderStepChain(inst: WorkflowInstanceView): TemplateResult {
  const steps: TemplateResult[] = [];
  for (let i = 0; i < inst.totalSteps; i++) {
    const status = stepVizStatus(i, inst.currentStep, inst.status);
    const agentLabel = inst.stepAgents[i] ?? `${t("workflows.eventStep")} ${i + 1}`;
    if (i > 0) {
      steps.push(
        html`
          <span class="wf-step-arrow" aria-hidden="true">\u2192</span>
        `,
      );
    }
    steps.push(html`
      <li class="wf-step-node wf-step--${status}" title="${agentLabel}" aria-label="${agentLabel}: ${status}">
        <span class="wf-step-icon">${stepVizIcon(status)}</span>
        <span class="wf-step-label">${agentLabel.replace("gstack-", "")}</span>
      </li>
    `);
  }
  return html`
    <ol class="wf-step-chain" aria-label="${t("workflows.progress")}: ${inst.currentStep}/${inst.totalSteps}">
      ${steps}
    </ol>
  `;
}

/** Localize lastEvent structured string from SSE controller */
function localizeLastEvent(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  if (raw === "completed") {
    return t("workflows.eventCompleted");
  }
  if (raw === "cancelled") {
    return t("workflows.eventCancelled");
  }
  if (raw.startsWith("step:")) {
    const parts = raw.split(":");
    return `${t("workflows.eventStep")} ${parts[1]}: ${parts[2] ?? ""}`;
  }
  if (raw.startsWith("failed:")) {
    return `${t("workflows.eventFailed")}: ${raw.slice(7)}`;
  }
  if (raw.startsWith("paused:")) {
    return `${t("workflows.eventPaused")}: ${raw.slice(7)}`;
  }
  return raw;
}

function eventTypeLabel(type: string): string {
  switch (type) {
    case "workflow_started":
      return t("workflows.eventStarted");
    case "workflow_completed":
      return t("workflows.eventCompleted");
    case "workflow_failed":
      return t("workflows.eventFailed");
    case "workflow_paused":
      return t("workflows.eventPaused");
    case "workflow_step_started":
      return t("workflows.eventStep");
    default:
      return type;
  }
}

// ─── Render Functions ───

function renderConnectionBadge(connected: boolean): TemplateResult {
  return html`
    <span class="wf-conn-badge ${connected ? "wf-conn--on" : "wf-conn--off"}" role="status" aria-live="polite">
      ${connected ? t("workflows.sseConnected") : t("workflows.disconnected")}
    </span>
  `;
}

function renderInstance(
  inst: WorkflowInstanceView,
  onResume?: (id: string) => void,
  onCancel?: (id: string) => void,
): TemplateResult {
  return html`
    <div class="wf-instance card ${statusClass(inst.status)}">
      <div class="wf-instance__header">
        <span class="wf-instance__icon">${statusIcon(inst.status)}</span>
        <span class="wf-instance__name">${inst.definitionName}</span>
        <span class="wf-instance__id muted">${inst.workflowId.slice(0, 12)}</span>
      </div>
      ${inst.totalSteps > 0 ? renderStepChain(inst) : progressBar(inst.currentStep, inst.totalSteps)}
      <div class="wf-instance__meta muted">
        ${formatTime(inst.startedAt)}
        ${inst.lastEvent ? html` &middot; ${localizeLastEvent(inst.lastEvent)}` : nothing}
      </div>
      ${
        inst.status === "paused" && onResume
          ? html`<button class="btn btn--sm wf-btn--primary" aria-label="${t("workflows.resume")} ${inst.definitionName}" @click=${() => onResume(inst.workflowId)}>${t("workflows.resume")}</button>`
          : nothing
      }
      ${
        (inst.status === "running" || inst.status === "paused") && onCancel
          ? html`<button class="btn btn--sm wf-btn--danger" aria-label="${t("workflows.cancel")} ${inst.definitionName}" @click=${() => onCancel(inst.workflowId)}>${t("workflows.cancel")}</button>`
          : nothing
      }
    </div>
  `;
}

function renderEventFeed(events: WorkflowEvent[]): TemplateResult {
  if (events.length === 0) {
    return html`<p class="muted">${t("workflows.noEvents")}</p>`;
  }

  const visible = events.slice(0, 30);
  return html`
    <div class="wf-event-feed">
      ${visible.map(
        (ev) => html`
          <div class="wf-event-entry">
            <span class="wf-event-ts muted">${formatTime(ev.timestamp)}</span>
            <span class="wf-event-type wf-event-type--${safeEventTypeClass(ev.type)}">${eventTypeLabel(ev.type)}</span>
            <span class="wf-event-detail muted">
              ${ev.payload.workflow_id ? String(ev.payload.workflow_id as string).slice(0, 12) : ""}
              ${ev.payload.agent_id ? html` &rarr; ${ev.payload.agent_id}` : nothing}
              ${ev.payload.reason ? html` (${ev.payload.reason})` : nothing}
            </span>
          </div>
        `,
      )}
    </div>
  `;
}

function renderDefinitions(
  defs: WorkflowDashboardProps["definitions"],
  onDelete?: (definitionId: string) => void,
  onExport?: () => void,
  onImport?: (json: string) => void,
): TemplateResult | typeof nothing {
  if (defs.length === 0 && !onImport) {
    return nothing;
  }

  return html`
    <details class="card wf-definitions">
      <summary class="ov-expandable-toggle">
        ${t("workflows.definitions")}
        <span class="ov-count-badge">${defs.length}</span>
      </summary>
      <div class="wf-def-list">
        ${defs.map(
          (d) => html`
            <div class="wf-def-entry">
              <span class="wf-def-name">${d.name}</span>
              <span class="wf-def-id muted">${d.id}</span>
              <span class="wf-def-steps muted">${d.stepCount} ${t("workflows.steps")}</span>
              ${
                onDelete
                  ? html`<button class="btn btn--sm wf-btn--danger wf-def-delete" aria-label="${t("workflows.deleteDefinition")} ${d.name}" @click=${() => onDelete(d.id)}>${t("workflows.deleteDefinition")}</button>`
                  : nothing
              }
            </div>
          `,
        )}
      </div>
      <div class="wf-def-actions">
        ${
          onExport && defs.length > 0
            ? html`<button class="btn btn--sm wf-btn--secondary" aria-label="${t("workflows.exportDefinitions")}" @click=${() => onExport()}>${t("workflows.exportDefinitions")}</button>`
            : nothing
        }
        ${
          onImport
            ? html`<button class="btn btn--sm wf-btn--secondary" aria-label="${t("workflows.importDefinitions")}" @click=${() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".json";
                input.addEventListener("change", () => {
                  const file = input.files?.[0];
                  if (!file) {
                    return;
                  }
                  const reader = new FileReader();
                  reader.addEventListener("load", () => {
                    if (typeof reader.result === "string") {
                      onImport(reader.result);
                    }
                  });
                  reader.readAsText(file);
                });
                input.click();
              }}>${t("workflows.importDefinitions")}</button>`
            : nothing
        }
      </div>
    </details>
  `;
}

// ─── Main Render ───

export function renderWorkflowDashboard(props: WorkflowDashboardProps): TemplateResult {
  const active = props.instances.filter((i) => i.status === "running" || i.status === "paused");
  const recent = props.instances.filter((i) => i.status === "completed" || i.status === "failed");

  return html`
    <section class="wf-dashboard" aria-label="${t("workflows.title")}">
      <div class="wf-dashboard__header">
        <h2>${t("workflows.title")}</h2>
        ${renderConnectionBadge(props.connected)}
      </div>

      ${
        active.length > 0
          ? html`
            <div class="wf-section">
              <h3>${t("workflows.activeWorkflows")} <span class="ov-count-badge">${active.length}</span></h3>
              <div class="wf-instance-grid">
                ${active.map((inst) => renderInstance(inst, props.onResume, props.onCancel))}
              </div>
            </div>
          `
          : html`<p class="muted">${t("workflows.noActive")}</p>`
      }

      ${
        recent.length > 0
          ? html`
            <div class="wf-section">
              <h3>${t("workflows.recent")}</h3>
              <div class="wf-instance-grid">
                ${recent.slice(0, 10).map((inst) => renderInstance(inst))}
              </div>
            </div>
          `
          : nothing
      }

      <div class="wf-section">
        <h3>${t("workflows.eventFeed")}</h3>
        ${renderEventFeed(props.events)}
      </div>

      ${renderDefinitions(props.definitions, props.onDeleteDefinition, props.onExportDefinitions, props.onImportDefinitions)}
    </section>
  `;
}
