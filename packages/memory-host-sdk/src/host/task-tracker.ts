/**
 * TaskTracker — Redis-backed async job state machine
 *
 * Manages lifecycle of long-running tasks (e.g., agent delegation, point-cloud processing).
 * Uses Redis HASH per job for atomic field updates.
 *
 * Key pattern: job:{job_id}
 * States:    pending → running → pending_approval → approved → completed | failed
 *                                    ↓
 *                                 rejected
 *
 * V-2.1: Human Approval Gate — sensitive operations pause at `pending_approval`
 *        until a human approves or rejects via POST /tasks/{id}/approve|reject.
 *
 * Architecture: Lives alongside ConversationMemoryService in OpenClaw's memory layer.
 * NemoClaw delegates via POST /delegate → creates job → polls GET /tasks/{id}.
 */

import Redis from "ioredis";

// ─── Types ───

export type JobStatus =
  | "pending"
  | "running"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "completed"
  | "failed";

export type JobRecord = {
  job_id: string;
  status: JobStatus;
  agent_id: string;
  /** What was requested */
  input: string;
  /** Result payload (JSON string), populated on completion */
  result: string | null;
  /** Error message, populated on failure */
  error: string | null;
  /** Source project that created this job */
  source: string;
  /** Correlation ID for cross-service tracing */
  correlation_id: string | null;
  /** Reason approval is requested (tool name, sensitivity, etc.) */
  approval_reason: string | null;
  /** Who approved or rejected (user ID / service name) */
  approval_by: string | null;
  /** Why the approval was rejected */
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskTrackerConfig = {
  /** Key prefix for job hashes (default: "job") */
  keyPrefix: string;
  /** Job TTL in seconds — auto-cleanup after completion (default: 3600 = 1h) */
  ttlSeconds: number;
  /** Max concurrent running jobs (default: 50) */
  maxConcurrent: number;
};

const DEFAULT_CONFIG: TaskTrackerConfig = {
  keyPrefix: "job",
  ttlSeconds: 3600,
  maxConcurrent: 50,
};

// ─── Service ───

export class TaskTrackerService {
  private redis: Redis;
  private config: TaskTrackerConfig;
  private ready = false;
  private _runningCount = 0;

  constructor(redis: Redis, config?: Partial<TaskTrackerConfig>) {
    this.redis = redis;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  markReady(): void {
    this.ready = true;
  }

  markNotReady(): void {
    this.ready = false;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get runningCount(): number {
    return this._runningCount;
  }

  private keyFor(jobId: string): string {
    return `${this.config.keyPrefix}:${jobId}`;
  }

  /**
   * Create a new job in "pending" state.
   * Returns false if at capacity (maxConcurrent reached).
   */
  async createJob(params: {
    jobId: string;
    agentId: string;
    input: string;
    source: string;
    correlationId?: string;
  }): Promise<boolean> {
    if (!this.ready) {
      return false;
    }

    if (this._runningCount >= this.config.maxConcurrent) {
      return false;
    }

    const now = new Date().toISOString();
    const key = this.keyFor(params.jobId);

    try {
      const record: Record<string, string> = {
        job_id: params.jobId,
        status: "pending",
        agent_id: params.agentId,
        input: params.input,
        result: "",
        error: "",
        source: params.source,
        correlation_id: params.correlationId ?? "",
        approval_reason: "",
        approval_by: "",
        rejection_reason: "",
        created_at: now,
        updated_at: now,
      };

      await this.redis.pipeline().hset(key, record).expire(key, this.config.ttlSeconds).exec();

      return true;
    } catch (err) {
      console.warn(`[task-tracker] createJob failed: ${String(err)}`);
      return false;
    }
  }

  /**
   * Transition job to "running" state.
   */
  async markRunning(jobId: string): Promise<void> {
    if (!this.ready) {
      return;
    }
    try {
      const key = this.keyFor(jobId);
      await this.redis.hset(key, {
        status: "running",
        updated_at: new Date().toISOString(),
      });
      this._runningCount++;
    } catch (err) {
      console.warn(`[task-tracker] markRunning failed: ${String(err)}`);
    }
  }

  /**
   * Transition job to "completed" with result payload.
   */
  async markCompleted(jobId: string, result: string): Promise<void> {
    if (!this.ready) {
      return;
    }
    try {
      const key = this.keyFor(jobId);
      await this.redis
        .pipeline()
        .hset(key, {
          status: "completed",
          result,
          updated_at: new Date().toISOString(),
        })
        .expire(key, this.config.ttlSeconds)
        .exec();
      this._runningCount = Math.max(0, this._runningCount - 1);
    } catch (err) {
      console.warn(`[task-tracker] markCompleted failed: ${String(err)}`);
    }
  }

  /**
   * Transition job to "failed" with error message.
   */
  async markFailed(jobId: string, error: string): Promise<void> {
    if (!this.ready) {
      return;
    }
    try {
      const key = this.keyFor(jobId);
      await this.redis
        .pipeline()
        .hset(key, {
          status: "failed",
          error,
          updated_at: new Date().toISOString(),
        })
        .expire(key, this.config.ttlSeconds)
        .exec();
      this._runningCount = Math.max(0, this._runningCount - 1);
    } catch (err) {
      console.warn(`[task-tracker] markFailed failed: ${String(err)}`);
    }
  }

  /**
   * Transition job to "pending_approval" — pauses execution until human approves.
   * @param reason - Why approval is needed (e.g. "sensitive tool: get_financial_summary")
   */
  async markPendingApproval(jobId: string, reason: string): Promise<void> {
    if (!this.ready) {
      return;
    }
    try {
      const key = this.keyFor(jobId);
      await this.redis
        .pipeline()
        .hset(key, {
          status: "pending_approval",
          approval_reason: reason,
          updated_at: new Date().toISOString(),
        })
        .expire(key, this.config.ttlSeconds * 4) // longer TTL for human review
        .exec();
    } catch (err) {
      console.warn(`[task-tracker] markPendingApproval failed: ${String(err)}`);
    }
  }

  /**
   * Approve a pending_approval job — transitions to "approved" so execution can resume.
   * Returns true if job was in pending_approval state and got approved.
   */
  /**
   * Atomic CAS: only transitions if current status is "pending_approval".
   * Uses Lua script to prevent TOCTOU race between concurrent approve/reject.
   */
  async approve(jobId: string, approvedBy: string): Promise<boolean> {
    if (!this.ready) {
      return false;
    }
    try {
      const key = this.keyFor(jobId);
      const result = await this.redis.eval(
        `if redis.call('hget', KEYS[1], 'status') == 'pending_approval' then
          redis.call('hset', KEYS[1], 'status', 'approved', 'approval_by', ARGV[1], 'updated_at', ARGV[2])
          redis.call('expire', KEYS[1], tonumber(ARGV[3]))
          return 1
        end
        return 0`,
        1,
        key,
        approvedBy,
        new Date().toISOString(),
        String(this.config.ttlSeconds),
      );
      return result === 1;
    } catch (err) {
      console.warn(`[task-tracker] approve failed: ${String(err)}`);
      return false;
    }
  }

  /**
   * Reject a pending_approval job — transitions to "rejected" (terminal state).
   * Running count is decremented since the job will not proceed.
   */
  /**
   * Atomic CAS: only transitions if current status is "pending_approval".
   * Uses Lua script to prevent TOCTOU race between concurrent approve/reject.
   */
  async reject(jobId: string, rejectedBy: string, reason?: string): Promise<boolean> {
    if (!this.ready) {
      return false;
    }
    try {
      const key = this.keyFor(jobId);
      const result = await this.redis.eval(
        `if redis.call('hget', KEYS[1], 'status') == 'pending_approval' then
          redis.call('hset', KEYS[1], 'status', 'rejected', 'approval_by', ARGV[1], 'rejection_reason', ARGV[2], 'updated_at', ARGV[3])
          redis.call('expire', KEYS[1], tonumber(ARGV[4]))
          return 1
        end
        return 0`,
        1,
        key,
        rejectedBy,
        reason ?? "",
        new Date().toISOString(),
        String(this.config.ttlSeconds),
      );
      if (result === 1) {
        this._runningCount = Math.max(0, this._runningCount - 1);
        return true;
      }
      return false;
    } catch (err) {
      console.warn(`[task-tracker] reject failed: ${String(err)}`);
      return false;
    }
  }

  /**
   * Get job record by ID. Returns null if not found or expired.
   */
  async getJob(jobId: string): Promise<JobRecord | null> {
    if (!this.ready) {
      return null;
    }
    try {
      const key = this.keyFor(jobId);
      const data = await this.redis.hgetall(key);
      if (!data || !data.job_id) {
        return null;
      }

      return {
        job_id: data.job_id,
        status: (data.status as JobStatus) || "pending",
        agent_id: data.agent_id || "",
        input: data.input || "",
        result: data.result || null,
        error: data.error || null,
        source: data.source || "",
        correlation_id: data.correlation_id || null,
        approval_reason: data.approval_reason || null,
        approval_by: data.approval_by || null,
        rejection_reason: data.rejection_reason || null,
        created_at: data.created_at || "",
        updated_at: data.updated_at || "",
      };
    } catch (err) {
      console.warn(`[task-tracker] getJob failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * Reconcile in-memory runningCount with Redis ground truth.
   * Scans all job keys and counts those with status "running".
   * Call periodically (e.g., every 5 minutes) to recover from count drift
   * caused by markFailed/markCompleted failures or process restarts.
   */
  async reconcileRunningCount(): Promise<number> {
    if (!this.ready) {
      return this._runningCount;
    }
    try {
      const pattern = `${this.config.keyPrefix}:*`;
      let cursor = "0";
      let actualRunning = 0;

      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          // Pipeline batch HGET to reduce round trips
          const pipe = this.redis.pipeline();
          for (const key of keys) {
            pipe.hget(key, "status");
          }
          const results = await pipe.exec();
          if (results) {
            for (const [err, status] of results) {
              if (!err && status === "running") {
                actualRunning++;
              }
            }
          }
        }
      } while (cursor !== "0");

      const drift = this._runningCount - actualRunning;
      if (drift !== 0) {
        console.info(
          `[task-tracker] reconcileRunningCount: corrected ${this._runningCount} → ${actualRunning} (drift: ${drift})`,
        );
      }
      this._runningCount = actualRunning;
      return actualRunning;
    } catch (err) {
      console.warn(`[task-tracker] reconcileRunningCount failed: ${String(err)}`);
      return this._runningCount;
    }
  }

  /**
   * Observability: return tracker stats.
   */
  getStats(): { ready: boolean; runningJobs: number; maxConcurrent: number } {
    return {
      ready: this.ready,
      runningJobs: this._runningCount,
      maxConcurrent: this.config.maxConcurrent,
    };
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
      // Force disconnect if quit fails (e.g., connection already broken)
      this.redis.disconnect();
    }
  }
}
