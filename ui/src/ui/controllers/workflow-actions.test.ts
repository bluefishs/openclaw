import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resumeWorkflow,
  cancelWorkflow,
  createWorkflowDefinition,
  deleteWorkflowDefinition,
} from "./workflow-actions.ts";

// ─── Fetch Mock Helpers ───

function mockFetchOk(data: unknown = { ok: true }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(data),
    }),
  );
}

function mockFetchError(status: number, errorMessage: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: () => Promise.resolve({ error: { message: errorMessage } }),
    }),
  );
}

function mockFetchErrorNonJson(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    }),
  );
}

function mockFetchThrow(): void {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
}

// ─── Tests ───

describe("workflow-actions", () => {
  const baseUrl = "http://localhost:18789";
  const token = "test-token";

  beforeEach(() => {
    mockFetchOk();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── resumeWorkflow ───

  describe("resumeWorkflow", () => {
    it("sends POST to correct URL with headers", async () => {
      const result = await resumeWorkflow(baseUrl, token, "wf-123");
      expect(result).toEqual({ success: true });
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:18789/workflows/wf-123/resume",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Token": "test-token",
          },
          body: "{}",
        }),
      );
    });

    it("encodes workflow ID in URL", async () => {
      await resumeWorkflow(baseUrl, token, "wf/special&id");
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("wf%2Fspecial%26id"),
        expect.anything(),
      );
    });

    it("returns error on HTTP failure", async () => {
      mockFetchError(404, "Workflow not found");
      const result = await resumeWorkflow(baseUrl, token, "wf-bad");
      expect(result).toEqual({ success: false, error: "Workflow not found" });
    });

    it("returns HTTP status when response is not JSON", async () => {
      mockFetchErrorNonJson(500);
      const result = await resumeWorkflow(baseUrl, token, "wf-bad");
      expect(result).toEqual({ success: false, error: "HTTP 500" });
    });

    it("returns error on network failure", async () => {
      mockFetchThrow();
      const result = await resumeWorkflow(baseUrl, token, "wf-123");
      expect(result).toEqual({ success: false, error: "network error" });
    });
  });

  // ─── cancelWorkflow ───

  describe("cancelWorkflow", () => {
    it("sends DELETE to correct URL", async () => {
      const result = await cancelWorkflow(baseUrl, token, "wf-456");
      expect(result).toEqual({ success: true });
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:18789/workflows/wf-456",
        expect.objectContaining({
          method: "DELETE",
          headers: { "X-Service-Token": "test-token" },
        }),
      );
    });

    it("returns error on HTTP failure", async () => {
      mockFetchError(409, "Workflow already completed");
      const result = await cancelWorkflow(baseUrl, token, "wf-456");
      expect(result).toEqual({ success: false, error: "Workflow already completed" });
    });

    it("returns error on network failure", async () => {
      mockFetchThrow();
      const result = await cancelWorkflow(baseUrl, token, "wf-456");
      expect(result).toEqual({ success: false, error: "network error" });
    });
  });

  // ─── createWorkflowDefinition ───

  describe("createWorkflowDefinition", () => {
    const definition = {
      id: "my-workflow",
      name: "My Workflow",
      steps: [
        {
          agentId: "gstack-eng",
          triggerOn: "completed" as const,
          contextFrom: "original_input" as const,
        },
      ],
      maxDepth: 5,
    };

    it("sends POST with definition body", async () => {
      const result = await createWorkflowDefinition(baseUrl, token, definition);
      expect(result).toEqual({ success: true });
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:18789/workflows/definitions",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Token": "test-token",
          },
          body: JSON.stringify(definition),
        }),
      );
    });

    it("returns error on 409 conflict", async () => {
      mockFetchError(409, "Definition already exists");
      const result = await createWorkflowDefinition(baseUrl, token, definition);
      expect(result).toEqual({ success: false, error: "Definition already exists" });
    });

    it("returns error on 400 validation failure", async () => {
      mockFetchError(400, "Invalid agentId at step 0");
      const result = await createWorkflowDefinition(baseUrl, token, definition);
      expect(result).toEqual({ success: false, error: "Invalid agentId at step 0" });
    });

    it("returns error on network failure", async () => {
      mockFetchThrow();
      const result = await createWorkflowDefinition(baseUrl, token, definition);
      expect(result).toEqual({ success: false, error: "network error" });
    });
  });

  // ─── deleteWorkflowDefinition ───

  describe("deleteWorkflowDefinition", () => {
    it("sends DELETE to correct URL", async () => {
      const result = await deleteWorkflowDefinition(baseUrl, token, "my-workflow");
      expect(result).toEqual({ success: true });
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:18789/workflows/definitions/my-workflow",
        expect.objectContaining({
          method: "DELETE",
          headers: { "X-Service-Token": "test-token" },
        }),
      );
    });

    it("encodes definition ID in URL", async () => {
      await deleteWorkflowDefinition(baseUrl, token, "def/special&id");
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("def%2Fspecial%26id"),
        expect.anything(),
      );
    });

    it("returns error when definition has active instances", async () => {
      mockFetchError(409, "Cannot delete: active instances exist");
      const result = await deleteWorkflowDefinition(baseUrl, token, "my-workflow");
      expect(result).toEqual({ success: false, error: "Cannot delete: active instances exist" });
    });

    it("returns error on network failure", async () => {
      mockFetchThrow();
      const result = await deleteWorkflowDefinition(baseUrl, token, "my-workflow");
      expect(result).toEqual({ success: false, error: "network error" });
    });

    it("handles non-JSON error response gracefully", async () => {
      mockFetchErrorNonJson(502);
      const result = await deleteWorkflowDefinition(baseUrl, token, "my-workflow");
      expect(result).toEqual({ success: false, error: "HTTP 502" });
    });
  });
});
