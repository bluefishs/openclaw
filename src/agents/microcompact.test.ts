import { describe, it, expect, beforeEach } from "vitest";
import {
  microcompact,
  getMicrocompactMetrics,
  recordMicrocompactMetrics,
  resetMicrocompactMetrics,
  type MicrocompactOptions,
} from "./microcompact.js";

// Helper to create a tool result message
function toolResult(content: string, opts?: { timestamp?: number; toolCallId?: string }) {
  return {
    role: "toolResult" as const,
    content,
    timestamp: opts?.timestamp ?? Date.now(),
    toolCallId: opts?.toolCallId ?? `tc_${Math.random().toString(36).slice(2, 8)}`,
  };
}

function userMsg(content: string) {
  return { role: "user" as const, content, timestamp: Date.now() };
}

function assistantMsg(content: string) {
  return { role: "assistant" as const, content, timestamp: Date.now() };
}

describe("microcompact", () => {
  describe("truncation", () => {
    it("truncates tool results exceeding maxToolResultChars", () => {
      const bigContent = "x".repeat(5000);
      const messages = [toolResult(bigContent)];
      const { messages: out, stats } = microcompact(messages, { maxToolResultChars: 4000 });

      expect(stats.truncated).toBe(1);
      expect(stats.charsSaved).toBeGreaterThan(0);
      expect(out[0]).toHaveProperty("content");
      expect((out[0] as { content: string }).content.length).toBeLessThan(bigContent.length);
      expect((out[0] as { content: string }).content).toContain("chars omitted");
    });

    it("does not truncate small tool results", () => {
      const messages = [toolResult("short output")];
      const { messages: out, stats } = microcompact(messages);

      expect(stats.truncated).toBe(0);
      expect(stats.charsSaved).toBe(0);
      expect(out).toBe(messages); // reference equality — no copy
    });

    it("preserves head and tail when truncating", () => {
      const head = "HEAD_MARKER_" + "a".repeat(100);
      const tail = "b".repeat(100) + "_TAIL_MARKER";
      const middle = "m".repeat(5000);
      const content = head + middle + tail;

      const { messages: out } = microcompact([toolResult(content)], {
        maxToolResultChars: 2000,
        keepHeadChars: 200,
        keepTailChars: 200,
      });

      const result = (out[0] as { content: string }).content;
      expect(result).toContain("HEAD_MARKER_");
      expect(result).toContain("_TAIL_MARKER");
    });
  });

  describe("stale stripping", () => {
    it("strips old tool results exceeding max age", () => {
      const oldTs = Date.now() - 2 * 3600_000; // 2 hours ago
      // Content must exceed keepHeadChars (default 1500) to trigger stripping
      const messages = [toolResult("x".repeat(2000), { timestamp: oldTs })];
      const { stats } = microcompact(messages, { maxToolResultAgeMs: 3600_000 });

      expect(stats.stripped).toBe(1);
      expect(stats.charsSaved).toBeGreaterThan(0);
    });

    it("does not strip recent tool results", () => {
      const messages = [toolResult("recent output", { timestamp: Date.now() })];
      const { stats } = microcompact(messages, { maxToolResultAgeMs: 3600_000 });

      expect(stats.stripped).toBe(0);
    });

    it("keeps stub with age info for stripped results", () => {
      const oldTs = Date.now() - 90 * 60_000; // 90 min ago
      // Content must exceed keepHeadChars (default 1500) to trigger stripping
      const messages = [toolResult("x".repeat(2000), { timestamp: oldTs })];
      const { messages: out } = microcompact(messages, { maxToolResultAgeMs: 3600_000 });

      const result = (out[0] as { content: string }).content;
      expect(result).toContain("tool output expired");
      expect(result).toContain("90min ago");
    });
  });

  describe("collapse duplicates", () => {
    it("collapses consecutive duplicate toolCallIds", () => {
      const id = "tc_same";
      const messages = [
        toolResult("first", { toolCallId: id }),
        toolResult("duplicate", { toolCallId: id }),
      ];
      const { messages: out, stats } = microcompact(messages);

      expect(stats.collapsed).toBe(1);
      expect(out).toHaveLength(1);
    });

    it("does not collapse different toolCallIds", () => {
      const messages = [
        toolResult("first", { toolCallId: "tc_a" }),
        toolResult("second", { toolCallId: "tc_b" }),
      ];
      const { messages: out, stats } = microcompact(messages);

      expect(stats.collapsed).toBe(0);
      expect(out).toHaveLength(2);
    });
  });

  describe("mixed messages", () => {
    it("passes through non-toolResult messages unchanged", () => {
      const messages = [userMsg("hello"), assistantMsg("hi there"), toolResult("small output")];
      const { messages: out, stats } = microcompact(messages);

      expect(stats.charsSaved).toBe(0);
      expect(out).toBe(messages); // no changes
    });

    it("handles interleaved user/tool messages correctly", () => {
      const bigContent = "x".repeat(5000);
      const messages = [
        userMsg("do something"),
        toolResult(bigContent),
        assistantMsg("done"),
        toolResult("small"),
      ];
      const { messages: out, stats } = microcompact(messages, { maxToolResultChars: 4000 });

      expect(out).toHaveLength(4);
      expect(stats.truncated).toBe(1);
    });

    it("returns original array reference when no changes made", () => {
      const messages = [userMsg("hello"), assistantMsg("hi")];
      const { messages: out } = microcompact(messages);
      expect(out).toBe(messages);
    });
  });

  describe("custom options", () => {
    it("respects custom maxToolResultChars", () => {
      const messages = [toolResult("x".repeat(200))];
      const { stats } = microcompact(messages, { maxToolResultChars: 100 });
      expect(stats.truncated).toBe(1);
    });

    it("respects custom keepHeadChars and keepTailChars", () => {
      const content = "x".repeat(5000);
      const opts: MicrocompactOptions = {
        maxToolResultChars: 2000,
        keepHeadChars: 500,
        keepTailChars: 200,
      };
      const { messages: out } = microcompact([toolResult(content)], opts);
      const result = (out[0] as { content: string }).content;
      // Should be roughly keepHead + keepTail + omission notice
      expect(result.length).toBeLessThan(1000);
    });
  });
});

describe("microcompact metrics", () => {
  beforeEach(() => {
    resetMicrocompactMetrics();
  });

  it("starts with zero metrics", () => {
    const m = getMicrocompactMetrics();
    expect(m.totalRuns).toBe(0);
    expect(m.totalCharsSaved).toBe(0);
  });

  it("accumulates metrics across calls", () => {
    recordMicrocompactMetrics(10, 8, {
      truncated: 1,
      stripped: 1,
      collapsed: 0,
      charsSaved: 5000,
    });
    recordMicrocompactMetrics(5, 5, {
      truncated: 0,
      stripped: 0,
      collapsed: 0,
      charsSaved: 0,
    });

    const m = getMicrocompactMetrics();
    expect(m.totalRuns).toBe(2);
    expect(m.totalTruncated).toBe(1);
    expect(m.totalStripped).toBe(1);
    expect(m.totalCharsSaved).toBe(5000);
    expect(m.totalMessagesIn).toBe(15);
    expect(m.totalMessagesOut).toBe(13);
  });

  it("resets cleanly", () => {
    recordMicrocompactMetrics(10, 8, {
      truncated: 1,
      stripped: 0,
      collapsed: 0,
      charsSaved: 1000,
    });
    resetMicrocompactMetrics();
    const m = getMicrocompactMetrics();
    expect(m.totalRuns).toBe(0);
    expect(m.totalCharsSaved).toBe(0);
  });

  it("returns a copy, not a reference", () => {
    const m1 = getMicrocompactMetrics();
    recordMicrocompactMetrics(1, 1, {
      truncated: 0,
      stripped: 0,
      collapsed: 0,
      charsSaved: 0,
    });
    const m2 = getMicrocompactMetrics();
    expect(m1.totalRuns).toBe(0);
    expect(m2.totalRuns).toBe(1);
  });
});
