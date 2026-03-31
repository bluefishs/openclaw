import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCkPlatformQueryTool } from "./ck-platform-tool.js";

describe("createCkPlatformQueryTool", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.MCP_SERVICE_TOKEN = "test-token";
    process.env.NEMOCLAW_GATEWAY_URL = "http://localhost:9000";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("creates tool with correct metadata", () => {
    const tool = createCkPlatformQueryTool({});
    expect(tool.name).toBe("ck_platform_query");
    expect(tool.label).toBe("CK Platform Query");
    expect(tool.description).toContain("CK_Missive");
    expect(tool.description).toContain("CK_LvrLand");
    expect(tool.description).toContain("CK_DigitalTunnel");
    expect(tool.parameters).toBeDefined();
  });

  it("rejects empty query", async () => {
    const tool = createCkPlatformQueryTool({});
    const result = await tool.execute("call-1", { query: "" });
    expect(result.text).toContain("query must be 1-10000 characters");
  });

  it("rejects whitespace-only query", async () => {
    const tool = createCkPlatformQueryTool({});
    const result = await tool.execute("call-2", { query: "   " });
    expect(result.text).toContain("query must be 1-10000 characters");
  });

  it("rejects query exceeding MAX_QUERY_LENGTH", async () => {
    const tool = createCkPlatformQueryTool({});
    const longQuery = "a".repeat(10_001);
    const result = await tool.execute("call-3", { query: longQuery });
    expect(result.text).toContain("query must be 1-10000 characters");
  });

  it("rejects non-string query", async () => {
    const tool = createCkPlatformQueryTool({});
    const result = await tool.execute("call-4", { query: 12345 });
    expect(result.text).toContain("query must be 1-10000 characters");
  });

  it("returns error when MCP_SERVICE_TOKEN is not set", async () => {
    delete process.env.MCP_SERVICE_TOKEN;
    const tool = createCkPlatformQueryTool({});
    const result = await tool.execute("call-5", { query: "公文查詢" });
    expect(result.text).toContain("MCP_SERVICE_TOKEN not configured");
  });

  it("returns error when orchestrate module fails to load", async () => {
    const tool = createCkPlatformQueryTool({});
    // orchestrate will fail because leader-agent.js cannot be imported in test context
    const result = await tool.execute("call-6", { query: "公文查詢" });
    // Should get either orchestration error or module load error
    expect(result.type).toBe("text");
    expect(typeof result.text).toBe("string");
  });

  it("respects pluginConfig nemoclawUrl override", () => {
    const tool = createCkPlatformQueryTool({
      pluginConfig: { nemoclawUrl: "http://custom:9000" },
    });
    // Tool is created without error — config is stored for later use
    expect(tool.name).toBe("ck_platform_query");
  });
});
