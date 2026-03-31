import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskTrackerService } from "./task-tracker.js";

// ─── Mock Redis ───

function createMockRedis() {
  const _store = new Map<string, Map<string, string>>();
  const _ttls = new Map<string, number>();

  const pipelineOps: Array<() => [null, unknown]> = [];
  const pipeline = () => {
    pipelineOps.length = 0;
    const chain = {
      hset: (key: string, data: Record<string, string>) => {
        pipelineOps.push(() => {
          let hash = _store.get(key);
          if (!hash) {
            hash = new Map();
            _store.set(key, hash);
          }
          for (const [k, v] of Object.entries(data)) {
            hash.set(k, v);
          }
          return [null, "OK"] as [null, unknown];
        });
        return chain;
      },
      expire: (key: string, seconds: number) => {
        pipelineOps.push(() => {
          _ttls.set(key, seconds);
          return [null, "OK"] as [null, unknown];
        });
        return chain;
      },
      hget: (key: string, field: string) => {
        pipelineOps.push(() => {
          const hash = _store.get(key);
          const val = hash?.get(field) ?? null;
          return [null, val] as [null, unknown];
        });
        return chain;
      },
      exec: async () => {
        return pipelineOps.map((op) => op());
      },
    };
    return chain;
  };

  return {
    _store,
    _ttls,
    pipeline,
    hset: vi.fn(async (key: string, data: Record<string, string>) => {
      let hash = _store.get(key);
      if (!hash) {
        hash = new Map();
        _store.set(key, hash);
      }
      for (const [k, v] of Object.entries(data)) {
        hash.set(k, v);
      }
      return Object.keys(data).length;
    }),
    hgetall: vi.fn(async (key: string) => {
      const hash = _store.get(key);
      if (!hash) {
        return {};
      }
      const result: Record<string, string> = {};
      for (const [k, v] of hash) {
        result[k] = v;
      }
      return result;
    }),
    scan: vi.fn(
      async (
        cursor: string,
        _match: string,
        pattern: string,
        _count: string,
        _countVal: number,
      ) => {
        const keys: string[] = [];
        const prefix = pattern.replace("*", "");
        for (const key of _store.keys()) {
          if (key.startsWith(prefix)) {
            keys.push(key);
          }
        }
        return ["0", keys];
      },
    ),
    hget: vi.fn(async (key: string, field: string) => {
      const hash = _store.get(key);
      if (!hash) {
        return null;
      }
      return hash.get(field) ?? null;
    }),
    eval: vi.fn(async (_script: string, _numkeys: number, key: string, ...args: string[]) => {
      // Simulate atomic CAS Lua scripts for approve/reject
      const hash = _store.get(key);
      if (!hash || hash.get("status") !== "pending_approval") {
        return 0;
      }
      // Parse args: approve = [approvedBy, updatedAt, ttl], reject = [rejectedBy, reason, updatedAt, ttl]
      if (args.length === 3) {
        // approve: ARGV = [approvedBy, updatedAt, ttl]
        hash.set("status", "approved");
        hash.set("approval_by", args[0]);
        hash.set("updated_at", args[1]);
        _ttls.set(key, Number(args[2]));
      } else if (args.length === 4) {
        // reject: ARGV = [rejectedBy, reason, updatedAt, ttl]
        hash.set("status", "rejected");
        hash.set("approval_by", args[0]);
        hash.set("rejection_reason", args[1]);
        hash.set("updated_at", args[2]);
        _ttls.set(key, Number(args[3]));
      }
      return 1;
    }),
  } as unknown as {
    _store: Map<string, Map<string, string>>;
    _ttls: Map<string, number>;
  };
}

describe("TaskTrackerService", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let tracker: TaskTrackerService;

  beforeEach(() => {
    redis = createMockRedis();
    tracker = new TaskTrackerService(redis as never, { maxConcurrent: 3, ttlSeconds: 600 });
    tracker.markReady();
  });

  describe("createJob", () => {
    it("creates a job in pending state", async () => {
      const ok = await tracker.createJob({
        jobId: "j-001",
        agentId: "ck-missive",
        input: "查詢土地",
        source: "nemoclaw",
      });
      expect(ok).toBe(true);

      const job = await tracker.getJob("j-001");
      expect(job).not.toBeNull();
      expect(job!.status).toBe("pending");
      expect(job!.agent_id).toBe("ck-missive");
      expect(job!.input).toBe("查詢土地");
      expect(job!.source).toBe("nemoclaw");
    });

    it("includes correlation_id when provided", async () => {
      await tracker.createJob({
        jobId: "j-002",
        agentId: "ck-tunnel",
        input: "裂縫分析",
        source: "nemoclaw",
        correlationId: "corr-abc-123",
      });
      const job = await tracker.getJob("j-002");
      expect(job!.correlation_id).toBe("corr-abc-123");
    });

    it("returns false when not ready", async () => {
      tracker.markNotReady();
      const ok = await tracker.createJob({
        jobId: "j-003",
        agentId: "test",
        input: "x",
        source: "test",
      });
      expect(ok).toBe(false);
    });

    it("returns false when at max concurrent capacity", async () => {
      // Fill up to maxConcurrent (3)
      for (let i = 0; i < 3; i++) {
        await tracker.createJob({
          jobId: `cap-${i}`,
          agentId: "test",
          input: "x",
          source: "test",
        });
        await tracker.markRunning(`cap-${i}`);
      }

      const ok = await tracker.createJob({
        jobId: "cap-overflow",
        agentId: "test",
        input: "x",
        source: "test",
      });
      expect(ok).toBe(false);
    });
  });

  describe("lifecycle transitions", () => {
    beforeEach(async () => {
      await tracker.createJob({
        jobId: "life-1",
        agentId: "ck-missive",
        input: "test",
        source: "nemoclaw",
      });
    });

    it("transitions pending → running → completed", async () => {
      await tracker.markRunning("life-1");
      let job = await tracker.getJob("life-1");
      expect(job!.status).toBe("running");
      expect(tracker.runningCount).toBe(1);

      await tracker.markCompleted("life-1", JSON.stringify({ answer: "done" }));
      job = await tracker.getJob("life-1");
      expect(job!.status).toBe("completed");
      expect(job!.result).toBe(JSON.stringify({ answer: "done" }));
      expect(tracker.runningCount).toBe(0);
    });

    it("transitions pending → running → failed", async () => {
      await tracker.markRunning("life-1");
      await tracker.markFailed("life-1", "timeout exceeded");
      const job = await tracker.getJob("life-1");
      expect(job!.status).toBe("failed");
      expect(job!.error).toBe("timeout exceeded");
      expect(tracker.runningCount).toBe(0);
    });
  });

  describe("getJob", () => {
    it("returns null for non-existent job", async () => {
      const job = await tracker.getJob("nonexistent");
      expect(job).toBeNull();
    });

    it("returns null when not ready", async () => {
      await tracker.createJob({
        jobId: "g-1",
        agentId: "test",
        input: "x",
        source: "test",
      });
      tracker.markNotReady();
      const job = await tracker.getJob("g-1");
      expect(job).toBeNull();
    });
  });

  describe("getStats", () => {
    it("returns tracker statistics", async () => {
      const stats = tracker.getStats();
      expect(stats.ready).toBe(true);
      expect(stats.runningJobs).toBe(0);
      expect(stats.maxConcurrent).toBe(3);
    });

    it("reflects running count after transitions", async () => {
      await tracker.createJob({ jobId: "s-1", agentId: "a", input: "x", source: "s" });
      await tracker.markRunning("s-1");
      expect(tracker.getStats().runningJobs).toBe(1);

      await tracker.markCompleted("s-1", "ok");
      expect(tracker.getStats().runningJobs).toBe(0);
    });
  });

  describe("markNotReady lifecycle", () => {
    it("prevents all operations when not ready", async () => {
      tracker.markNotReady();
      expect(tracker.isReady).toBe(false);

      // All ops should silently no-op
      const ok = await tracker.createJob({ jobId: "nr-1", agentId: "a", input: "x", source: "s" });
      expect(ok).toBe(false);

      await tracker.markRunning("nr-1"); // no-op
      await tracker.markCompleted("nr-1", "x"); // no-op
      await tracker.markFailed("nr-1", "x"); // no-op
      const job = await tracker.getJob("nr-1");
      expect(job).toBeNull();
    });

    it("re-enables after markReady", async () => {
      tracker.markNotReady();
      tracker.markReady();
      const ok = await tracker.createJob({ jobId: "re-1", agentId: "a", input: "x", source: "s" });
      expect(ok).toBe(true);
    });
  });

  describe("running count floor", () => {
    it("never goes below zero", async () => {
      // Complete without running first — should not go negative
      await tracker.markCompleted("phantom", "ok");
      expect(tracker.runningCount).toBe(0);

      await tracker.markFailed("phantom2", "err");
      expect(tracker.runningCount).toBe(0);
    });
  });

  describe("approval gate (V-2.1)", () => {
    beforeEach(async () => {
      await tracker.createJob({
        jobId: "approval-1",
        agentId: "ck-missive",
        input: "查詢財務報表",
        source: "nemoclaw",
      });
      await tracker.markRunning("approval-1");
    });

    it("transitions running → pending_approval with reason", async () => {
      await tracker.markPendingApproval("approval-1", "sensitive tool: get_financial_summary");
      const job = await tracker.getJob("approval-1");
      expect(job!.status).toBe("pending_approval");
      expect(job!.approval_reason).toBe("sensitive tool: get_financial_summary");
    });

    it("approves a pending_approval job", async () => {
      await tracker.markPendingApproval("approval-1", "sensitive operation");
      const ok = await tracker.approve("approval-1", "admin-user");
      expect(ok).toBe(true);

      const job = await tracker.getJob("approval-1");
      expect(job!.status).toBe("approved");
      expect(job!.approval_by).toBe("admin-user");
    });

    it("rejects a pending_approval job with reason", async () => {
      await tracker.markPendingApproval("approval-1", "sensitive operation");
      const ok = await tracker.reject("approval-1", "admin-user", "不允許查看此資料");
      expect(ok).toBe(true);

      const job = await tracker.getJob("approval-1");
      expect(job!.status).toBe("rejected");
      expect(job!.approval_by).toBe("admin-user");
      expect(job!.rejection_reason).toBe("不允許查看此資料");
    });

    it("reject decrements running count", async () => {
      expect(tracker.runningCount).toBe(1);
      await tracker.markPendingApproval("approval-1", "test");
      await tracker.reject("approval-1", "user", "denied");
      expect(tracker.runningCount).toBe(0);
    });

    it("cannot approve a non-pending_approval job", async () => {
      // Job is in "running" state, not "pending_approval"
      const ok = await tracker.approve("approval-1", "admin");
      expect(ok).toBe(false);
    });

    it("cannot reject a non-pending_approval job", async () => {
      const ok = await tracker.reject("approval-1", "admin", "nope");
      expect(ok).toBe(false);
    });

    it("cannot approve non-existent job", async () => {
      const ok = await tracker.approve("nonexistent", "admin");
      expect(ok).toBe(false);
    });

    it("cannot reject non-existent job", async () => {
      const ok = await tracker.reject("nonexistent", "admin");
      expect(ok).toBe(false);
    });

    it("approval fields are null for new jobs (before any approval action)", async () => {
      const job = await tracker.getJob("approval-1");
      expect(job!.approval_reason).toBeNull();
      expect(job!.approval_by).toBeNull();
      expect(job!.rejection_reason).toBeNull();
    });

    it("full lifecycle: pending → running → pending_approval → approved → completed", async () => {
      await tracker.markPendingApproval("approval-1", "finance data");
      await tracker.approve("approval-1", "manager");
      await tracker.markCompleted("approval-1", JSON.stringify({ answer: "approved result" }));

      const job = await tracker.getJob("approval-1");
      expect(job!.status).toBe("completed");
      expect(job!.approval_by).toBe("manager");
      expect(job!.result).toContain("approved result");
      expect(tracker.runningCount).toBe(0);
    });
  });

  describe("reconcileRunningCount", () => {
    it("corrects drifted running count to match Redis state", async () => {
      // Create 2 jobs and mark both running
      await tracker.createJob({ jobId: "rc-1", agentId: "a", input: "x", source: "s" });
      await tracker.createJob({ jobId: "rc-2", agentId: "a", input: "x", source: "s" });
      await tracker.markRunning("rc-1");
      await tracker.markRunning("rc-2");
      expect(tracker.runningCount).toBe(2);

      // Simulate drift: manually complete one in Redis but don't update in-memory count
      const hash = redis._store.get("job:rc-2");
      hash!.set("status", "completed");

      // In-memory count is still 2, but only 1 is actually running
      expect(tracker.runningCount).toBe(2);

      const actual = await tracker.reconcileRunningCount();
      expect(actual).toBe(1);
      expect(tracker.runningCount).toBe(1);
    });

    it("returns current count when not ready", async () => {
      await tracker.createJob({ jobId: "rc-3", agentId: "a", input: "x", source: "s" });
      await tracker.markRunning("rc-3");
      tracker.markNotReady();

      const count = await tracker.reconcileRunningCount();
      expect(count).toBe(1); // unchanged
    });

    it("handles zero running jobs correctly", async () => {
      await tracker.createJob({ jobId: "rc-4", agentId: "a", input: "x", source: "s" });
      await tracker.markRunning("rc-4");
      await tracker.markCompleted("rc-4", "done");

      const count = await tracker.reconcileRunningCount();
      expect(count).toBe(0);
      expect(tracker.runningCount).toBe(0);
    });
  });
});
