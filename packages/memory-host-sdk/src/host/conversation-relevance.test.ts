import { describe, it, expect, vi } from "vitest";
import { rankByRelevance, type EmbeddingFn } from "./conversation-relevance.js";

// Simple mock embeddings: use character code averages as a "vector"
function mockEmbedFn(): EmbeddingFn {
  return async (text: string) => {
    if (!text.trim()) {
      return [];
    }
    // Generate deterministic vector from text (3 dimensions for simplicity)
    const codes = Array.from(text).map((c) => c.charCodeAt(0));
    const avg = codes.reduce((a, b) => a + b, 0) / codes.length;
    return [avg / 128, (avg * 0.7) / 128, (avg * 1.3) / 128];
  };
}

function msg(content: string) {
  return { content, role: "user" as const };
}

describe("rankByRelevance", () => {
  it("returns empty array for empty messages", async () => {
    const result = await rankByRelevance([], "query", mockEmbedFn());
    expect(result).toEqual([]);
  });

  it("returns empty array for empty query", async () => {
    const result = await rankByRelevance([msg("hello")], "", mockEmbedFn());
    expect(result).toEqual([]);
  });

  it("returns all messages with scores when no topK limit", async () => {
    const messages = [msg("hello"), msg("world"), msg("test")];
    const result = await rankByRelevance(messages, "hello", mockEmbedFn());
    expect(result).toHaveLength(3);
    for (const r of result) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.index).toBeGreaterThanOrEqual(0);
    }
  });

  it("respects topK limit", async () => {
    const messages = [msg("a"), msg("b"), msg("c"), msg("d"), msg("e")];
    const result = await rankByRelevance(messages, "a", mockEmbedFn(), { topK: 2 });
    expect(result).toHaveLength(2);
  });

  it("preserves original message order in output", async () => {
    const messages = [msg("first"), msg("second"), msg("third")];
    const result = await rankByRelevance(messages, "test", mockEmbedFn());
    // Output should be sorted by index (original order), not by score
    for (let i = 1; i < result.length; i++) {
      expect(result[i].index).toBeGreaterThan(result[i - 1].index);
    }
  });

  it("applies recency boost to later messages", async () => {
    const messages = [msg("test message"), msg("test message")]; // identical content
    const result = await rankByRelevance(messages, "test", mockEmbedFn(), {
      recencyBoost: 0.5,
    });
    // Later message (index 1) should have higher score due to recency boost
    const sorted = [...result].toSorted((a, b) => b.score - a.score);
    expect(sorted[0].index).toBe(1);
  });

  it("filters by minScore", async () => {
    const embed = vi.fn<Parameters<EmbeddingFn>, ReturnType<EmbeddingFn>>();
    embed.mockResolvedValueOnce([1, 0, 0]); // query
    embed.mockResolvedValueOnce([1, 0, 0]); // msg 0 — identical to query
    embed.mockResolvedValueOnce([0, 0, 1]); // msg 1 — orthogonal

    const messages = [msg("similar"), msg("different")];
    const result = await rankByRelevance(messages, "query", embed, { minScore: 0.5 });
    // Only the similar message should pass the threshold
    expect(result.length).toBeLessThanOrEqual(2);
    for (const r of result) {
      expect(r.score).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("gracefully falls back when embed throws", async () => {
    const failEmbed: EmbeddingFn = async () => {
      throw new Error("Ollama unavailable");
    };
    const messages = [msg("hello"), msg("world")];
    const result = await rankByRelevance(messages, "test", failEmbed);
    // Should return all messages with score 1.0 (fallback)
    expect(result).toHaveLength(2);
    for (const r of result) {
      expect(r.score).toBe(1.0);
    }
  });

  it("gracefully falls back when embed returns empty vector", async () => {
    const emptyEmbed: EmbeddingFn = async () => [];
    const messages = [msg("hello")];
    const result = await rankByRelevance(messages, "test", emptyEmbed);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(1.0);
  });

  it("handles individual message embed failures", async () => {
    let callCount = 0;
    const partialFail: EmbeddingFn = async (_text) => {
      callCount++;
      if (callCount === 1) {
        return [1, 0, 0];
      } // query succeeds
      if (callCount === 2) {
        throw new Error("fail");
      } // first msg fails
      return [0.9, 0.1, 0]; // second msg succeeds
    };
    const messages = [msg("fail"), msg("succeed")];
    const result = await rankByRelevance(messages, "test", partialFail);
    expect(result).toHaveLength(2);
    // Failed message should get neutral score of 0.5
    const failedMsg = result.find((r) => r.index === 0);
    expect(failedMsg?.score).toBe(0.5);
  });

  it("disables recency boost when set to 0", async () => {
    const messages = [msg("test message"), msg("test message")];
    const result = await rankByRelevance(messages, "test", mockEmbedFn(), {
      recencyBoost: 0,
    });
    // With identical content and no recency boost, scores should be very close
    const scores = result.map((r) => r.score);
    expect(Math.abs(scores[0] - scores[1])).toBeLessThan(0.01);
  });
});
