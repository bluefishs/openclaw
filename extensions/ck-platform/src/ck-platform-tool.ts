/**
 * CK Platform Query Tool
 *
 * Provides cross-domain query capability to OpenClaw agents via the Leader Agent
 * orchestration pipeline. When an agent receives a question that spans multiple
 * CK_ projects (Missive, LvrLand, Tunnel), it can use this tool to fan-out
 * the query to relevant domain agents via NemoClaw gateway.
 *
 * Flow: Agent → ck_platform_query tool → Leader Agent orchestrate()
 *       → NemoClaw /api/gateway/delegate → domain plugins → collected results
 */

import { Type } from "@sinclair/typebox";

type OrchestrateFn = (
  query: string,
  opts: {
    serviceToken: string;
    correlationId?: string;
    nemoclawUrl?: string;
    subtaskTimeoutMs?: number;
  },
) => Promise<{
  orchestrated: boolean;
  subResults: Array<{
    agentId: string;
    agentName: string;
    success: boolean;
    answer: string | null;
    error: string | null;
    latencyMs: number;
  }>;
  synthesisPrompt: string | null;
  totalLatencyMs: number;
}>;

/**
 * Dynamically import the orchestrate function from the leader-agent module.
 * Handles both source (dev) and built (dist) layouts.
 */
async function loadOrchestrate(): Promise<OrchestrateFn> {
  // Source checkout (dev/test)
  try {
    const mod = await import("../../../src/gateway/leader-agent.js");
    if (typeof (mod as Record<string, unknown>).orchestrate === "function") {
      return (mod as Record<string, unknown>).orchestrate as OrchestrateFn;
    }
  } catch {
    // ignore — try dist path
  }

  // Built install
  try {
    const mod = await import("../../../dist/gateway/leader-agent.js");
    if (typeof (mod as Record<string, unknown>).orchestrate === "function") {
      return (mod as Record<string, unknown>).orchestrate as OrchestrateFn;
    }
  } catch {
    // ignore
  }

  throw new Error("Internal error: orchestrate() not available from leader-agent module");
}

type PluginConfig = {
  nemoclawUrl?: string;
  subtaskTimeoutMs?: number;
};

type PluginApi = {
  pluginConfig?: unknown;
};

export function createCkPlatformQueryTool(api: PluginApi) {
  const pluginCfg = (api.pluginConfig ?? {}) as PluginConfig;

  return {
    name: "ck_platform_query",
    label: "CK Platform Query",
    description: [
      "Query the CK platform's domain services (公文系統 CK_Missive, 地圖測繪 CK_LvrLand, 隧道監控 CK_DigitalTunnel) via NemoClaw cross-domain orchestration.",
      "Use this tool when the user's question relates to:",
      "- 公文/派工/收文/發文/文號/知識圖譜 → CK_Missive",
      "- 地圖/地籍/地價/土地/公告現值/都更/地段 → CK_LvrLand",
      "- 隧道/感測/監控/警報/裂縫/點雲/巡檢 → CK_DigitalTunnel",
      "- Cross-domain questions spanning multiple services above",
      "The tool automatically determines which domain agents to query and returns their responses.",
    ].join("\n"),
    parameters: Type.Object({
      query: Type.String({
        description:
          "The user's query to route to CK platform domain agents. Use the original user question or a refined version.",
      }),
    }),

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const MAX_QUERY_LENGTH = 10_000;
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!query || query.length > MAX_QUERY_LENGTH) {
        return {
          type: "text" as const,
          text: `Error: query must be 1-${MAX_QUERY_LENGTH} characters.`,
        };
      }

      const serviceToken = process.env.MCP_SERVICE_TOKEN;
      if (!serviceToken) {
        return {
          type: "text" as const,
          text: "Error: MCP_SERVICE_TOKEN not configured. Cannot authenticate with NemoClaw gateway.",
        };
      }

      const nemoclawUrl =
        pluginCfg.nemoclawUrl || process.env.NEMOCLAW_GATEWAY_URL || "http://nemoclaw_tower:9000";

      let orchestrate: OrchestrateFn;
      try {
        orchestrate = await loadOrchestrate();
      } catch (err) {
        return {
          type: "text" as const,
          text: `Error: Failed to load orchestration module: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      try {
        const result = await orchestrate(query, {
          serviceToken,
          nemoclawUrl,
          subtaskTimeoutMs: pluginCfg.subtaskTimeoutMs ?? 120_000,
        });

        // Format results for the agent
        if (result.subResults.length === 0) {
          return {
            type: "text" as const,
            text: "No CK platform domain agents matched this query. The question may not relate to 公文、地圖、隧道 domains.",
          };
        }

        const parts: string[] = [];
        parts.push(
          `CK Platform Query Results (${result.totalLatencyMs}ms, ${result.subResults.length} agent(s)):`,
        );
        parts.push("");

        for (const sub of result.subResults) {
          parts.push(`## ${sub.agentName} (${sub.agentId})`);
          if (sub.success && sub.answer) {
            parts.push(sub.answer);
          } else {
            parts.push(`Query failed: ${sub.error ?? "no response"}`);
          }
          parts.push(`(${sub.latencyMs}ms)`);
          parts.push("");
        }

        return { type: "text" as const, text: parts.join("\n") };
      } catch (err) {
        return {
          type: "text" as const,
          text: `CK Platform query error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
