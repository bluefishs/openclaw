/**
 * Conversation Relevance Scoring — rank history messages by semantic similarity
 * to the current query using local embeddings (Ollama).
 *
 * POC: Uses cosine similarity between query embedding and message content embeddings.
 * Falls back to returning all messages unranked if embeddings are unavailable.
 *
 * Design: Pure async function, no side effects. Caller decides what to do with scores.
 */

import { cosineSimilarity } from "./internal.js";

export type ScoredMessage<T> = {
  message: T;
  score: number;
  index: number;
};

export type EmbeddingFn = (text: string) => Promise<number[]>;

/**
 * Rank messages by semantic similarity to a query.
 *
 * @param messages - Conversation history messages
 * @param query - Current user query to rank against
 * @param embed - Async function that returns embedding vector for a text
 * @param opts - Ranking options
 * @returns Top-K messages sorted by relevance (highest first), preserving original order
 */
export async function rankByRelevance<T extends { content: string }>(
  messages: T[],
  query: string,
  embed: EmbeddingFn,
  opts?: {
    /** Max messages to return (default: all) */
    topK?: number;
    /** Min similarity score to include (default: 0.0) */
    minScore?: number;
    /** Recency boost: multiply score by 1 + (index/total * boost) (default: 0.1) */
    recencyBoost?: number;
  },
): Promise<ScoredMessage<T>[]> {
  const topK = opts?.topK ?? messages.length;
  const minScore = opts?.minScore ?? 0.0;
  const recencyBoost = opts?.recencyBoost ?? 0.1;

  if (messages.length === 0 || !query.trim()) {
    return [];
  }

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embed(query);
  } catch {
    // Embedding unavailable — return all messages unranked (graceful fallback)
    return messages.map((message, index) => ({ message, score: 1.0, index }));
  }

  if (queryEmbedding.length === 0) {
    return messages.map((message, index) => ({ message, score: 1.0, index }));
  }

  // Batch embed all messages
  const scored: ScoredMessage<T>[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    try {
      const msgEmbedding = await embed(msg.content);
      let score = msgEmbedding.length > 0 ? cosineSimilarity(queryEmbedding, msgEmbedding) : 0;

      // Apply recency boost (later messages get slight boost)
      if (recencyBoost > 0 && messages.length > 1) {
        score *= 1 + (i / (messages.length - 1)) * recencyBoost;
      }

      if (score >= minScore) {
        scored.push({ message: msg, score, index: i });
      }
    } catch {
      // Individual embedding failure — include with neutral score
      scored.push({ message: msg, score: 0.5, index: i });
    }
  }

  // Sort by score descending, take top-K
  scored.sort((a, b) => b.score - a.score);
  const topMessages = scored.slice(0, topK);

  // Re-sort by original index to preserve conversation order
  topMessages.sort((a, b) => a.index - b.index);

  return topMessages;
}

/**
 * Create an Ollama-backed embedding function.
 *
 * @param ollamaUrl - Ollama API URL (e.g., "http://ollama:11434")
 * @param model - Embedding model name (e.g., "nomic-embed-text")
 */
export function createOllamaEmbedFn(ollamaUrl: string, model = "nomic-embed-text"): EmbeddingFn {
  return async (text: string): Promise<number[]> => {
    const res = await fetch(`${ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embed failed: ${res.status}`);
    }
    const data = (await res.json()) as { embeddings?: number[][] };
    return data.embeddings?.[0] ?? [];
  };
}
