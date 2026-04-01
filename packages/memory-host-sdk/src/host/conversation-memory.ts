/**
 * ConversationMemoryService — ioredis-backed stateful conversation memory
 *
 * Uses Redis LIST operations for atomic, race-free conversation storage:
 *   - RPUSH: append turn (atomic, no read-modify-write)
 *   - LTRIM: cap history (防爆護欄)
 *   - LRANGE: read history
 *   - EXPIRE: session TTL refresh
 *
 * Key pattern: conv:{agent_id}:{session_id}
 *
 * Architecture: Lives in OpenClaw (inference layer) because conversation
 * history is integral to prompt assembly. NemoClaw (control plane) stays stateless.
 */

import Redis from "ioredis";

// ─── Secret Redaction (self-contained, no cross-package deps) ───

const SECRET_PATTERNS: RegExp[] = [
  /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[=:]\s*["']?([^\s"'\\]{18,})["']?/gi,
  /"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*"([^"]{18,})"/gi,
  /\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(ghp_[A-Za-z0-9]{20,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(gsk_[A-Za-z0-9_-]{10,})\b/g,
  /\b(AIza[0-9A-Za-z\-_]{20,})\b/g,
  /\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b/g,
  /\b(\d{6,}:[A-Za-z0-9_-]{20,})\b/g,
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => {
      if (match.includes("PRIVATE KEY-----")) {
        const lines = match.split(/\r?\n/).filter(Boolean);
        return lines.length >= 2 ? `${lines[0]}\n…redacted…\n${lines[lines.length - 1]}` : "***";
      }
      return match.length >= 18 ? `${match.slice(0, 6)}…${match.slice(-4)}` : "***";
    });
  }
  return result;
}

// ─── Types ───

export type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
  ts: string;
};

export type ConversationMemoryConfig = {
  /** Redis connection URL or host (default: redis://shared-redis:6379) */
  redisUrl: string;
  /** Redis DB index for conversation storage (default: 4) */
  db: number;
  /** Max conversation turns to retain, each turn = 2 messages (default: 20) */
  maxTurns: number;
  /** Session TTL in seconds (default: 86400 = 24h) */
  ttlSeconds: number;
};

function loadConfigFromEnv(): ConversationMemoryConfig {
  const host = process.env.CONVERSATION_REDIS_HOST || "shared-redis";
  const port = process.env.CONVERSATION_REDIS_PORT || "6379";
  return {
    redisUrl: process.env.CONVERSATION_REDIS_URL || `redis://${host}:${port}`,
    db: parseInt(process.env.CONVERSATION_REDIS_DB || "4", 10),
    maxTurns: parseInt(process.env.CONVERSATION_MAX_TURNS || "20", 10),
    ttlSeconds: parseInt(process.env.CONVERSATION_TTL_SECONDS || "86400", 10),
  };
}

/** Validate key components to prevent Redis key injection */
const SAFE_KEY_RE = /^[a-zA-Z0-9_\-.]+$/;
function sanitize(value: string): string {
  return SAFE_KEY_RE.test(value) ? value : value.replace(/[^a-zA-Z0-9_\-.]/g, "_");
}

// ─── Service ───

export class ConversationMemoryService {
  private redis: Redis;
  private config: ConversationMemoryConfig;
  private ready = false;
  private _saveTurnErrors = 0;
  private _saveTurnTotal = 0;

  constructor(redis: Redis, config?: Partial<ConversationMemoryConfig>) {
    this.redis = redis;
    this.config = { ...loadConfigFromEnv(), ...config };
  }

  /** Mark as ready once Redis connection is confirmed */
  markReady(): void {
    this.ready = true;
  }

  /** Mark as not ready when Redis connection is lost */
  markNotReady(): void {
    this.ready = false;
  }

  private keyFor(agentId: string, sessionId: string): string {
    return `conv:${sanitize(agentId)}:${sanitize(sessionId)}`;
  }

  /** Guard: ensure session keys always have the expected prefix */
  private assertSessionKey(key: string): void {
    if (!key.startsWith("conv:")) {
      throw new Error(`Invalid session key: must start with "conv:" (got "${key.slice(0, 20)}")`);
    }
  }

  /**
   * Load conversation history for a session.
   * Returns empty array if Redis unavailable or no history exists.
   */
  async loadContext(sessionKey: string): Promise<HistoryMessage[]> {
    if (!this.ready) {
      return [];
    }
    this.assertSessionKey(sessionKey);
    try {
      const raw = await this.redis.lrange(sessionKey, 0, -1);
      if (!raw || raw.length === 0) {
        return [];
      }

      const messages: HistoryMessage[] = [];
      for (const item of raw) {
        try {
          const parsed = JSON.parse(item) as HistoryMessage;
          if (parsed.role && parsed.content) {
            messages.push(parsed);
          }
        } catch {
          // Skip malformed entries
        }
      }

      // Refresh TTL on read (active session stays alive)
      // Track recall frequency for adaptive TTL (fire-and-forget)
      await this.redis.expire(sessionKey, this.config.ttlSeconds);
      this.redis
        .pipeline()
        .hincrby("conv:recall_counts", sessionKey, 1)
        .expire("conv:recall_counts", this.config.ttlSeconds * 2)
        .exec()
        .catch(() => {});

      return messages;
    } catch (err) {
      console.warn(`[conversation-memory] loadContext failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Save a conversation turn (user message + AI response).
   * Uses atomic Redis LIST ops — no read-modify-write race condition.
   *
   * Pipeline: RPUSH → RPUSH → LTRIM → EXPIRE (4 commands, 1 round-trip)
   */
  async saveTurn(sessionKey: string, userMsg: string, aiMsg: string): Promise<void> {
    if (!this.ready) {
      return;
    }
    this.assertSessionKey(sessionKey);
    this._saveTurnTotal++;
    try {
      const now = new Date().toISOString();
      const userEntry: HistoryMessage = { role: "user", content: redactSecrets(userMsg), ts: now };
      const aiEntry: HistoryMessage = { role: "assistant", content: redactSecrets(aiMsg), ts: now };

      // Pipeline: batch 4 commands into 1 round-trip
      const maxEntries = this.config.maxTurns * 2; // turns × 2 messages each
      await this.redis
        .pipeline()
        .rpush(sessionKey, JSON.stringify(userEntry))
        .rpush(sessionKey, JSON.stringify(aiEntry))
        .ltrim(sessionKey, -maxEntries, -1) // Keep last N entries (防爆護欄)
        .expire(sessionKey, this.config.ttlSeconds)
        .exec();
    } catch (err) {
      this._saveTurnErrors++;
      console.warn(`[conversation-memory] saveTurn failed: ${String(err)}`);
    }
  }

  /**
   * Build a session key from agent_id + session_id.
   */
  buildKey(agentId: string, sessionId: string): string {
    return this.keyFor(agentId, sessionId);
  }

  /**
   * Format history as prompt-ready context for LLM injection.
   * Uses XML-style tags to prevent role prefix confusion in content.
   * Adds staleness markers for messages older than staleThresholdHours (default: 24h).
   */
  formatForPrompt(history: HistoryMessage[], staleThresholdHours = 24): string {
    if (history.length === 0) {
      return "";
    }

    const now = Date.now();
    const staleMs = staleThresholdHours * 3600_000;

    const lines = history.map((m) => {
      const tag = m.role === "user" ? "user" : "assistant";
      const escaped = m.content.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      // Age-based staleness: older messages may reflect outdated context
      const age = m.ts ? now - new Date(m.ts).getTime() : 0;
      const staleAttr =
        age > staleMs ? ` stale="true" age_hours="${Math.floor(age / 3600_000)}"` : "";
      return `<${tag}${staleAttr}>${escaped}</${tag}>`;
    });

    // Prepend staleness advisory if any messages are stale
    const hasStale = history.some((m) => m.ts && now - new Date(m.ts).getTime() > staleMs);
    const advisory = hasStale
      ? `<stale_advisory>部分對話記憶已超過 ${staleThresholdHours} 小時，可能不反映當前狀態，請以最新資訊為準。</stale_advisory>\n`
      : "";

    return `${advisory}<conversation_history>\n${lines.join("\n")}\n</conversation_history>`;
  }

  /**
   * Clear conversation history for a session.
   */
  async clear(sessionKey: string): Promise<void> {
    if (!this.ready) {
      return;
    }
    this.assertSessionKey(sessionKey);
    try {
      await this.redis.del(sessionKey);
    } catch (err) {
      console.warn(`[conversation-memory] clear failed: ${String(err)}`);
    }
  }

  /**
   * Health check.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === "PONG";
    } catch {
      return false;
    }
  }

  /**
   * Observability: return Redis connection status and memory stats.
   */
  async getStats(): Promise<{
    healthy: boolean;
    ready: boolean;
    status: string;
    saveTurnTotal: number;
    saveTurnErrors: number;
    memoryUsed?: string;
    dbSize?: number;
  }> {
    const healthy = await this.isHealthy();
    const stats: {
      healthy: boolean;
      ready: boolean;
      status: string;
      saveTurnTotal: number;
      saveTurnErrors: number;
      memoryUsed?: string;
      dbSize?: number;
    } = {
      healthy,
      ready: this.ready,
      saveTurnTotal: this._saveTurnTotal,
      saveTurnErrors: this._saveTurnErrors,
      status: this.redis.status,
    };
    if (healthy) {
      try {
        const info = await this.redis.info("memory");
        const memMatch = info.match(/used_memory_human:(\S+)/);
        if (memMatch) {
          stats.memoryUsed = memMatch[1];
        }
        stats.dbSize = await this.redis.dbsize();
      } catch {
        // stats are best-effort
      }
    }
    return stats;
  }

  /**
   * Decay idle sessions — scan conv:* keys and halve TTL for sessions that haven't
   * been accessed recently. Sessions below minTtlSeconds are left to expire naturally.
   *
   * Call periodically (e.g., every 30 minutes via setInterval) to reclaim Redis memory
   * from abandoned sessions without abruptly deleting potentially useful context.
   *
   * Returns the number of sessions whose TTL was reduced.
   */
  /**
   * Adaptive decay — scan conv:* keys and adjust TTL based on recall frequency:
   *   - High-frequency sessions (recall >= highRecallThreshold): extend TTL to max
   *   - Low-frequency / never recalled: halve TTL until minTtlSeconds
   *   - Sessions below minTtlSeconds: left to expire naturally
   *
   * Returns { decayed, extended } counts.
   */
  async decayIdleSessions(minTtlSeconds = 3600, highRecallThreshold = 5): Promise<number> {
    if (!this.ready) {
      return 0;
    }
    try {
      // Load recall counts in one shot
      const recallMap = new Map<string, number>();
      try {
        const raw = await this.redis.hgetall("conv:recall_counts");
        for (const [key, count] of Object.entries(raw)) {
          recallMap.set(key, parseInt(count, 10) || 0);
        }
      } catch {
        // recall counts unavailable — fall back to uniform decay
      }

      let decayed = 0;
      let cursor = "0";
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, "MATCH", "conv:*", "COUNT", 100);
        cursor = nextCursor;
        for (const key of keys) {
          if (key === "conv:recall_counts") {
            continue;
          }
          const ttl = await this.redis.ttl(key);
          if (ttl <= minTtlSeconds) {
            continue;
          }

          const recallCount = recallMap.get(key) ?? 0;

          if (recallCount >= highRecallThreshold) {
            // High-frequency: extend TTL back to max (reward active sessions)
            if (ttl < this.config.ttlSeconds) {
              await this.redis.expire(key, this.config.ttlSeconds);
            }
          } else {
            // Low-frequency: halve TTL (accelerate decay)
            const factor = recallCount === 0 ? 3 : 2; // never-recalled decays 3x faster
            const newTtl = Math.max(minTtlSeconds, Math.floor(ttl / factor));
            if (newTtl < ttl) {
              await this.redis.expire(key, newTtl);
              decayed++;
            }
          }
        }
      } while (cursor !== "0");
      return decayed;
    } catch (err) {
      console.warn(`[conversation-memory] decayIdleSessions failed: ${String(err)}`);
      return 0;
    }
  }

  /**
   * Graceful shutdown — mark service as not ready and disconnect Redis.
   * Call from server-close handler to prevent connection leaks.
   */
  async shutdown(): Promise<void> {
    this.markNotReady();
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

/** Mask password in Redis URL to prevent leaking credentials in logs */
function maskRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "redis://***";
  }
}

// ─── Factory: create Redis + service (call once at startup) ───

export function createConversationMemory(configOverride?: Partial<ConversationMemoryConfig>): {
  redis: Redis;
  service: ConversationMemoryService;
} {
  const config = { ...loadConfigFromEnv(), ...configOverride };

  const redis = new Redis(config.redisUrl, {
    db: config.db,
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      // Exponential backoff: 200ms, 400ms, 800ms... capped at 30s
      return Math.min(times * 200, 30_000);
    },
    lazyConnect: true, // Don't block startup
    enableReadyCheck: true,
  });

  const service = new ConversationMemoryService(redis, config);

  redis.on("ready", () => {
    service.markReady();
    console.log(
      `[conversation-memory] Redis connected: ${maskRedisUrl(config.redisUrl)}/db${config.db}`,
    );
  });

  redis.on("error", (err) => {
    console.warn(`[conversation-memory] Redis error: ${String(err)}`);
  });

  redis.on("close", () => {
    service.markNotReady();
    console.warn("[conversation-memory] Redis connection closed, will auto-reconnect");
  });

  // Non-blocking connect — ioredis handles reconnection automatically
  redis.connect().catch((err) => {
    console.warn(`[conversation-memory] Initial connection failed (will retry): ${String(err)}`);
  });

  return { redis, service };
}
