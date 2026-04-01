/**
 * Metrics controller — fetches /metrics HTTP endpoint for observability dashboard.
 *
 * Unlike other controllers that use WebSocket RPC, this uses HTTP fetch because
 * the /metrics endpoint is served via gstack-http-stages (not gateway RPC).
 */

export type MetricsResult = {
  timestamp: string;
  memory: {
    healthy: boolean;
    ready: boolean;
    saveTurnTotal: number;
    saveTurnErrors: number;
    memoryUsed?: string;
    dbSize?: number;
  } | null;
  tasks: {
    ready: boolean;
    runningJobs: number;
    maxConcurrent: number;
  } | null;
  events: {
    ready: boolean;
    activeConnections: number;
    maxConnections: number;
  } | null;
  workflow: {
    definitions: number;
    activeInstances: number;
    maxConcurrent: number;
  } | null;
  microcompact: {
    totalRuns: number;
    totalTruncated: number;
    totalStripped: number;
    totalCollapsed: number;
    totalCharsSaved: number;
    totalMessagesIn: number;
    totalMessagesOut: number;
  } | null;
  circuitBreakers: Record<
    string,
    { state: string; consecutiveFailures: number; lastFailureAt: number }
  >;
  alerts: string[];
};

export type MetricsState = {
  metricsLoading: boolean;
  metricsResult: MetricsResult | null;
  metricsError: string | null;
  metricsLastFetch: number;
};

export function createMetricsState(): MetricsState {
  return {
    metricsLoading: false,
    metricsResult: null,
    metricsError: null,
    metricsLastFetch: 0,
  };
}

/**
 * Fetch /metrics from the gateway. Requires service token.
 * The base URL is inferred from the current page location (same host, gateway port).
 */
export async function loadMetrics(
  state: MetricsState,
  gatewayBaseUrl: string,
  serviceToken: string,
): Promise<void> {
  if (state.metricsLoading) {
    return;
  }
  state.metricsLoading = true;
  state.metricsError = null;
  try {
    const res = await fetch(`${gatewayBaseUrl}/metrics`, {
      headers: { "X-Service-Token": serviceToken },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    state.metricsResult = (await res.json()) as MetricsResult;
    state.metricsLastFetch = Date.now();
  } catch (err) {
    state.metricsError = err instanceof Error ? err.message : String(err);
  } finally {
    state.metricsLoading = false;
  }
}
