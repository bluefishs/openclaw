import { connectGateway } from "./app-gateway.ts";
import {
  startLogsPolling,
  startNodesPolling,
  stopLogsPolling,
  stopNodesPolling,
  startDebugPolling,
  stopDebugPolling,
} from "./app-polling.ts";
import { observeTopbar, scheduleChatScroll, scheduleLogsScroll } from "./app-scroll.ts";
import {
  applySettingsFromUrl,
  attachThemeListener,
  detachThemeListener,
  inferBasePath,
  syncTabWithLocation,
  syncThemeWithSettings,
} from "./app-settings.ts";
import { loadControlUiBootstrapConfig } from "./controllers/control-ui-bootstrap.ts";
import { WorkflowSseController } from "./controllers/workflow-sse.ts";
import type { Tab } from "./navigation.ts";
import type { WorkflowEvent, WorkflowInstanceView } from "./views/workflow-dashboard.ts";

type LifecycleHost = {
  basePath: string;
  client?: { stop: () => void } | null;
  connectGeneration: number;
  connected?: boolean;
  tab: Tab;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  serverVersion: string | null;
  chatHasAutoScrolled: boolean;
  chatManualRefreshInFlight: boolean;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string | null;
  logsAutoFollow: boolean;
  logsAtBottom: boolean;
  logsEntries: unknown[];
  popStateHandler: () => void;
  topbarObserver: ResizeObserver | null;
  // Workflow SSE
  workflowSseController?: WorkflowSseController | null;
  workflowInstances: WorkflowInstanceView[];
  workflowEvents: WorkflowEvent[];
  workflowDefinitions: Array<{ id: string; name: string; stepCount: number }>;
  workflowConnected: boolean;
  settings: { token?: string; gatewayUrl?: string };
};

// ─── Workflow SSE ───

/** Convert ws:// or wss:// URL to http:// or https:// */
function wsUrlToHttp(wsUrl: string): string {
  return wsUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
}

function startWorkflowSse(host: LifecycleHost): void {
  stopWorkflowSse(host);
  const baseUrl = host.settings.gatewayUrl ? wsUrlToHttp(host.settings.gatewayUrl) : host.basePath;
  const token = host.settings.token ?? "";
  const controller = new WorkflowSseController(baseUrl, token, {
    onStateChange(state) {
      host.workflowConnected = state.connected;
      host.workflowInstances = [...state.instances.values()];
      host.workflowEvents = state.events;
    },
  });
  host.workflowSseController = controller;
  void controller.connect();

  // Fetch workflow definitions catalog
  void fetchWorkflowDefinitions(baseUrl, token, host);
}

async function fetchWorkflowDefinitions(
  baseUrl: string,
  token: string,
  host: LifecycleHost,
): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/workflows/definitions`, {
      headers: token ? { "X-Service-Token": token } : {},
    });
    if (!res.ok) {
      return;
    }
    const data = (await res.json()) as {
      success: boolean;
      definitions?: Array<{ id: string; name: string; stepCount: number }>;
    };
    if (data.success && data.definitions) {
      host.workflowDefinitions = data.definitions;
    }
  } catch {
    // Non-critical — dashboard still functions without definitions catalog
  }
}

function stopWorkflowSse(host: LifecycleHost): void {
  if (host.workflowSseController) {
    host.workflowSseController.dispose();
    host.workflowSseController = null;
  }
}

export function handleConnected(host: LifecycleHost) {
  const connectGeneration = ++host.connectGeneration;
  host.basePath = inferBasePath();
  applySettingsFromUrl(host as unknown as Parameters<typeof applySettingsFromUrl>[0]);
  const bootstrapReady = loadControlUiBootstrapConfig(host);
  syncTabWithLocation(host as unknown as Parameters<typeof syncTabWithLocation>[0], true);
  syncThemeWithSettings(host as unknown as Parameters<typeof syncThemeWithSettings>[0]);
  attachThemeListener(host as unknown as Parameters<typeof attachThemeListener>[0]);
  window.addEventListener("popstate", host.popStateHandler);
  void bootstrapReady.finally(() => {
    if (host.connectGeneration !== connectGeneration) {
      return;
    }
    connectGateway(host as unknown as Parameters<typeof connectGateway>[0]);
  });
  startNodesPolling(host as unknown as Parameters<typeof startNodesPolling>[0]);
  if (host.tab === "logs") {
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
  }
  if (host.tab === "debug") {
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  }
  if (host.tab === "workflows") {
    startWorkflowSse(host);
  }
}

export function handleFirstUpdated(host: LifecycleHost) {
  observeTopbar(host as unknown as Parameters<typeof observeTopbar>[0]);
}

export function handleDisconnected(host: LifecycleHost) {
  host.connectGeneration += 1;
  window.removeEventListener("popstate", host.popStateHandler);
  stopNodesPolling(host as unknown as Parameters<typeof stopNodesPolling>[0]);
  stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  stopWorkflowSse(host);
  host.client?.stop();
  host.client = null;
  host.connected = false;
  detachThemeListener(host as unknown as Parameters<typeof detachThemeListener>[0]);
  host.topbarObserver?.disconnect();
  host.topbarObserver = null;
}

export function handleUpdated(host: LifecycleHost, changed: Map<PropertyKey, unknown>) {
  if (host.tab === "chat" && host.chatManualRefreshInFlight) {
    return;
  }
  if (
    host.tab === "chat" &&
    (changed.has("chatMessages") ||
      changed.has("chatToolMessages") ||
      changed.has("chatStream") ||
      changed.has("chatLoading") ||
      changed.has("tab"))
  ) {
    const forcedByTab = changed.has("tab");
    const forcedByLoad =
      changed.has("chatLoading") && changed.get("chatLoading") === true && !host.chatLoading;
    // Detect streaming start: chatStream changed from null/undefined to a string value
    const previousStream = changed.get("chatStream") as string | null | undefined;
    const streamJustStarted =
      changed.has("chatStream") &&
      (previousStream === null || previousStream === undefined) &&
      typeof host.chatStream === "string";
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      forcedByTab || forcedByLoad || streamJustStarted || !host.chatHasAutoScrolled,
    );
  }
  if (
    host.tab === "logs" &&
    (changed.has("logsEntries") || changed.has("logsAutoFollow") || changed.has("tab"))
  ) {
    if (host.logsAutoFollow && host.logsAtBottom) {
      scheduleLogsScroll(
        host as unknown as Parameters<typeof scheduleLogsScroll>[0],
        changed.has("tab") || changed.has("logsAutoFollow"),
      );
    }
  }
  // Start/stop workflow SSE based on tab visibility
  if (changed.has("tab")) {
    if (host.tab === "workflows") {
      startWorkflowSse(host);
    } else if (host.workflowSseController) {
      stopWorkflowSse(host);
    }
  }
}
