import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveGstackDelegateUrl } from "./gstack-roles.js";

describe("resolveGstackDelegateUrl", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_DELEGATE_URL", "");
  });

  it("returns default URL when env var is not set", () => {
    const url = resolveGstackDelegateUrl();
    expect(url).toBe("http://localhost:18789/delegate");
  });

  it("returns custom URL when valid http:// is set", () => {
    vi.stubEnv("OPENCLAW_DELEGATE_URL", "http://my-gateway:9000/delegate");
    const url = resolveGstackDelegateUrl();
    expect(url).toBe("http://my-gateway:9000/delegate");
  });

  it("returns custom URL when valid https:// is set", () => {
    vi.stubEnv("OPENCLAW_DELEGATE_URL", "https://secure.example.com/api/delegate");
    const url = resolveGstackDelegateUrl();
    expect(url).toBe("https://secure.example.com/api/delegate");
  });

  it("falls back to default for ftp:// protocol (SSRF protection)", () => {
    vi.stubEnv("OPENCLAW_DELEGATE_URL", "ftp://evil.com/steal");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const url = resolveGstackDelegateUrl();
    expect(url).toBe("http://localhost:18789/delegate");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid protocol"));
    consoleSpy.mockRestore();
  });

  it("falls back to default for file:// protocol (SSRF protection)", () => {
    vi.stubEnv("OPENCLAW_DELEGATE_URL", "file:///etc/passwd");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const url = resolveGstackDelegateUrl();
    expect(url).toBe("http://localhost:18789/delegate");
    consoleSpy.mockRestore();
  });

  it("falls back to default for garbage input", () => {
    vi.stubEnv("OPENCLAW_DELEGATE_URL", "not-a-url-at-all");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const url = resolveGstackDelegateUrl();
    expect(url).toBe("http://localhost:18789/delegate");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid OPENCLAW_DELEGATE_URL"),
    );
    consoleSpy.mockRestore();
  });

  it("normalizes URL (adds trailing slash for origin-only URL)", () => {
    vi.stubEnv("OPENCLAW_DELEGATE_URL", "http://custom-host:8080");
    const url = resolveGstackDelegateUrl();
    // new URL("http://custom-host:8080").toString() => "http://custom-host:8080/"
    expect(url).toBe("http://custom-host:8080/");
  });
});
