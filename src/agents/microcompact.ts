/**
 * Microcompact — Rule-based, zero-LLM-cost tool output cleanup.
 *
 * Runs before heavy LLM-based compaction to reduce token waste:
 *   1. Truncate oversized tool results (keeping head + tail summary)
 *   2. Collapse consecutive identical tool results (e.g., repeated health checks)
 *   3. Strip stale tool outputs older than a configurable age
 *
 * Design: <1ms execution, pure function, no side effects.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type MicrocompactOptions = {
  /** Max characters per tool result content before truncation (default: 4000) */
  maxToolResultChars?: number;
  /** Max age in ms for tool results before stripping content (default: 1h) */
  maxToolResultAgeMs?: number;
  /** Number of leading chars to keep when truncating (default: 1500) */
  keepHeadChars?: number;
  /** Number of trailing chars to keep when truncating (default: 500) */
  keepTailChars?: number;
};

const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_MAX_AGE_MS = 3600_000; // 1 hour
const DEFAULT_KEEP_HEAD = 1500;
const DEFAULT_KEEP_TAIL = 500;

type ToolResultMessage = AgentMessage & {
  role: "toolResult";
  content: string;
  timestamp?: number;
  toolCallId?: string;
};

function isToolResult(msg: AgentMessage): msg is ToolResultMessage {
  return (
    msg &&
    typeof msg === "object" &&
    (msg as { role?: unknown }).role === "toolResult" &&
    typeof (msg as { content?: unknown }).content === "string"
  );
}

function truncateContent(content: string, keepHead: number, keepTail: number): string {
  const head = content.slice(0, keepHead);
  const tail = content.slice(-keepTail);
  const omitted = content.length - keepHead - keepTail;
  return `${head}\n\n[… ${omitted} chars omitted …]\n\n${tail}`;
}

/** Hard upper bound to prevent processing absurdly large message arrays. */
const MAX_MESSAGES = 10_000;
/** Hard upper bound per-message content length to skip pathological inputs. */
const MAX_CONTENT_SCAN_LENGTH = 10_000_000; // 10MB

export function microcompact(
  messages: AgentMessage[],
  options?: MicrocompactOptions,
): { messages: AgentMessage[]; stats: MicrocompactStats } {
  // Guard: skip processing if input is absurdly large
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      messages: messages ?? [],
      stats: { truncated: 0, stripped: 0, collapsed: 0, charsSaved: 0 },
    };
  }
  const safeMessages = messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages;

  const maxChars = Math.max(100, options?.maxToolResultChars ?? DEFAULT_MAX_CHARS);
  const maxAgeMs = Math.max(60_000, options?.maxToolResultAgeMs ?? DEFAULT_MAX_AGE_MS);
  const keepHead = Math.max(50, options?.keepHeadChars ?? DEFAULT_KEEP_HEAD);
  const keepTail = Math.max(20, options?.keepTailChars ?? DEFAULT_KEEP_TAIL);

  const now = Date.now();
  let truncated = 0;
  let stripped = 0;
  let collapsed = 0;
  let charsSaved = 0;
  let changed = false;

  const out: AgentMessage[] = [];
  let lastToolCallId: string | undefined;

  for (const msg of safeMessages) {
    if (!isToolResult(msg)) {
      lastToolCallId = undefined;
      out.push(msg);
      continue;
    }

    const content = msg.content;
    // Guard: skip pathologically large content to prevent DoS
    if (content.length > MAX_CONTENT_SCAN_LENGTH) {
      const stub = `${String(content).slice(0, 200)}\n\n[content too large: ${content.length} chars, truncated for safety]`;
      charsSaved += content.length - stub.length;
      truncated++;
      changed = true;
      out.push({ ...msg, content: stub } as unknown as AgentMessage);
      lastToolCallId = msg.toolCallId;
      continue;
    }
    const ts = (msg as { timestamp?: number }).timestamp;

    // 1. Strip stale tool results (keep stub)
    if (typeof ts === "number" && now - ts > maxAgeMs && content.length > keepHead) {
      const ageMin = Math.floor((now - ts) / 60_000);
      const stub = `${String(content).slice(0, 200)}\n\n[tool output expired — ${ageMin}min ago, ${content.length} chars stripped]`;
      charsSaved += content.length - stub.length;
      stripped++;
      changed = true;
      out.push({ ...msg, content: stub } as unknown as AgentMessage);
      lastToolCallId = msg.toolCallId;
      continue;
    }

    // 2. Collapse consecutive duplicate tool results (same toolCallId prefix pattern)
    if (lastToolCallId && msg.toolCallId && lastToolCallId === msg.toolCallId) {
      collapsed++;
      charsSaved += content.length;
      changed = true;
      // Skip duplicate — already captured in previous message
      continue;
    }

    // 3. Truncate oversized content
    if (content.length > maxChars) {
      const trimmed = truncateContent(content, keepHead, keepTail);
      charsSaved += content.length - trimmed.length;
      truncated++;
      changed = true;
      out.push({ ...msg, content: trimmed } as unknown as AgentMessage);
      lastToolCallId = msg.toolCallId;
      continue;
    }

    lastToolCallId = msg.toolCallId;
    out.push(msg);
  }

  return {
    messages: changed ? out : messages,
    stats: { truncated, stripped, collapsed, charsSaved },
  };
}

export type MicrocompactStats = {
  truncated: number;
  stripped: number;
  collapsed: number;
  charsSaved: number;
};

// ─── Cumulative Metrics (singleton, survives across calls) ───

const cumulativeMetrics = {
  totalRuns: 0,
  totalTruncated: 0,
  totalStripped: 0,
  totalCollapsed: 0,
  totalCharsSaved: 0,
  totalMessagesIn: 0,
  totalMessagesOut: 0,
};

/** Record a microcompact run's stats into cumulative metrics. */
export function recordMicrocompactMetrics(
  inputCount: number,
  outputCount: number,
  stats: MicrocompactStats,
): void {
  cumulativeMetrics.totalRuns++;
  cumulativeMetrics.totalTruncated += stats.truncated;
  cumulativeMetrics.totalStripped += stats.stripped;
  cumulativeMetrics.totalCollapsed += stats.collapsed;
  cumulativeMetrics.totalCharsSaved += stats.charsSaved;
  cumulativeMetrics.totalMessagesIn += inputCount;
  cumulativeMetrics.totalMessagesOut += outputCount;
}

/** Get cumulative microcompact metrics for observability dashboards. */
export function getMicrocompactMetrics(): Readonly<typeof cumulativeMetrics> {
  return { ...cumulativeMetrics };
}

/** Reset cumulative metrics (for testing). */
export function resetMicrocompactMetrics(): void {
  cumulativeMetrics.totalRuns = 0;
  cumulativeMetrics.totalTruncated = 0;
  cumulativeMetrics.totalStripped = 0;
  cumulativeMetrics.totalCollapsed = 0;
  cumulativeMetrics.totalCharsSaved = 0;
  cumulativeMetrics.totalMessagesIn = 0;
  cumulativeMetrics.totalMessagesOut = 0;
}
