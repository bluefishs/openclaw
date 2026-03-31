import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it, expect, vi } from "vitest";
import { ensureCorrelationId, getCorrelationId, CORRELATION_HEADER } from "./correlation.js";

function createMockReq(headers: Record<string, string> = {}): IncomingMessage {
  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lowered[k.toLowerCase()] = v;
  }
  return { headers: lowered } as unknown as IncomingMessage;
}

function createMockRes(): ServerResponse & { _headers: Record<string, string> } {
  const _headers: Record<string, string> = {};
  return {
    _headers,
    setHeader: vi.fn((name: string, value: string) => {
      _headers[name] = value;
    }),
  } as unknown as ServerResponse & { _headers: Record<string, string> };
}

describe("ensureCorrelationId", () => {
  it("generates a UUID v4 when no incoming header", () => {
    const req = createMockReq();
    const res = createMockRes();
    const id = ensureCorrelationId(req, res);

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(res.setHeader).toHaveBeenCalledWith("X-Correlation-Id", id);
    expect(req.headers[CORRELATION_HEADER]).toBe(id);
  });

  it("propagates a valid incoming correlation ID", () => {
    const req = createMockReq({ "x-correlation-id": "abc-123-def" });
    const res = createMockRes();
    const id = ensureCorrelationId(req, res);

    expect(id).toBe("abc-123-def");
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(res.setHeader).toHaveBeenCalledWith("X-Correlation-Id", "abc-123-def");
  });

  it("propagates a valid UUID from upstream", () => {
    const upstream = "550e8400-e29b-41d4-a716-446655440000";
    const req = createMockReq({ "x-correlation-id": upstream });
    const res = createMockRes();
    const id = ensureCorrelationId(req, res);

    expect(id).toBe(upstream);
  });

  it("rejects and regenerates on invalid characters (injection attempt)", () => {
    const req = createMockReq({ "x-correlation-id": "abc; DROP TABLE--" });
    const res = createMockRes();
    const id = ensureCorrelationId(req, res);

    // Should NOT use the injected value
    expect(id).not.toContain(";");
    expect(id).not.toContain("DROP");
    expect(id).toMatch(/^[0-9a-f]{8}-/); // UUID generated instead
  });

  it("rejects overly long correlation IDs (> 128 chars)", () => {
    const longId = "a".repeat(200);
    const req = createMockReq({ "x-correlation-id": longId });
    const res = createMockRes();
    const id = ensureCorrelationId(req, res);

    expect(id).not.toBe(longId);
    expect(id.length).toBeLessThanOrEqual(128);
  });

  it("accepts correlation ID with dots and colons", () => {
    const req = createMockReq({ "x-correlation-id": "svc:nemoclaw.req.12345" });
    const res = createMockRes();
    const id = ensureCorrelationId(req, res);

    expect(id).toBe("svc:nemoclaw.req.12345");
  });

  it("rejects empty string and generates UUID", () => {
    const req = createMockReq({ "x-correlation-id": "" });
    const res = createMockRes();
    const id = ensureCorrelationId(req, res);

    expect(id).toMatch(/^[0-9a-f]{8}-/);
  });
});

describe("getCorrelationId", () => {
  it("returns the correlation ID set by ensureCorrelationId", () => {
    const req = createMockReq();
    const res = createMockRes();
    ensureCorrelationId(req, res);

    const id = getCorrelationId(req);
    expect(id).toBeDefined();
    expect(id).toMatch(/^[0-9a-f]{8}-/);
  });

  it("returns undefined when not initialized", () => {
    const req = createMockReq();
    const id = getCorrelationId(req);
    expect(id).toBeUndefined();
  });
});

describe("CORRELATION_HEADER constant", () => {
  it("is lowercase for HTTP header matching", () => {
    expect(CORRELATION_HEADER).toBe("x-correlation-id");
  });
});
