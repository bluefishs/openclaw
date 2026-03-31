import type { AnyAgentTool } from "openclaw/plugin-sdk/llm-task";
import { createCkPlatformQueryTool } from "./src/ck-platform-tool.js";

type OpenClawPluginApi = {
  registerTool: (tool: AnyAgentTool, opts?: { optional?: boolean }) => void;
  pluginConfig?: unknown;
  config?: unknown;
  runtime?: unknown;
};

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createCkPlatformQueryTool(api) as unknown as AnyAgentTool, { optional: true });
}
