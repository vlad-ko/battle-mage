import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn() }));
vi.mock("./logger", () => ({
  log: (...args: unknown[]) => logSpy(...args),
}));

// In-memory fake of the kv wrapper with real SET-NX semantics and TTL
// bookkeeping. Mirrors @upstash/redis: set returns "OK" on success and
// null when the NX condition loses.
const { store, ttls } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  ttls: new Map<string, number>(),
}));

vi.mock("./kv", () => ({
  kv: {
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    set: vi.fn(
      async (key: string, value: unknown, opts?: { ex?: number; nx?: boolean }) => {
        if (opts?.nx && store.has(key)) return null;
        store.set(key, value);
        if (opts?.ex) ttls.set(key, opts.ex);
        return "OK";
      },
    ),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  },
}));

import { kv } from "./kv";
import {
  stableSerialize,
  issueIdempotencyKey,
  executeIdempotent,
  LOCK_TTL_SEC,
  COMPLETED_TTL_SEC,
} from "./idempotency";

const NOW = 1_750_000_000_000; // pinned clock — never Date.now() in assertions
const KEY = "idem:issue:" + "a".repeat(64);
const ISSUE = { number: 7, title: "Fix flaky retry", url: "https://github.com/o/r/issues/7" };

beforeEach(() => {
  store.clear();
  ttls.clear();
  logSpy.mockClear();
  vi.mocked(kv.get).mockClear();
  vi.mocked(kv.set).mockClear();
  vi.mocked(kv.del).mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TTL constants (pinned — acceptance criteria of #125)", () => {
  it("lock TTL is exactly 60 seconds", () => {
    expect(LOCK_TTL_SEC).toBe(60);
  });

  it("completed-record TTL is exactly 30 days", () => {
    expect(COMPLETED_TTL_SEC).toBe(2_592_000);
  });
});

describe("stableSerialize (pure)", () => {
  it("is insensitive to object key insertion order", () => {
    expect(stableSerialize({ b: 1, a: 2 })).toBe(stableSerialize({ a: 2, b: 1 }));
    expect(stableSerialize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts keys recursively in nested objects", () => {
    expect(stableSerialize({ z: { b: 1, a: 2 } })).toBe('{"z":{"a":2,"b":1}}');
  });

  it("omits properties whose value is undefined", () => {
    expect(stableSerialize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("preserves array element order (arrays are ordered, objects are not)", () => {
    expect(stableSerialize([2, 1])).toBe("[2,1]");
    expect(stableSerialize(["a", "b"])).not.toBe(stableSerialize(["b", "a"]));
  });

  it("passes primitives and null through as JSON", () => {
    expect(stableSerialize("x")).toBe('"x"');
    expect(stableSerialize(42)).toBe("42");
    expect(stableSerialize(null)).toBe("null");
  });
});

describe("issueIdempotencyKey (pure)", () => {
  const input = { title: "Fix flaky retry", body: "Steps: ...", labels: ["bug", "p1"] };

  it("produces idem:issue:<64-hex> format", () => {
    expect(issueIdempotencyKey(input)).toMatch(/^idem:issue:[0-9a-f]{64}$/);
  });

  it("keyPrefix bucket for kv_op logs is 'idem' (no payload leakage)", () => {
    expect(issueIdempotencyKey(input).split(":")[0]).toBe("idem");
  });

  it("is stable across property insertion order", () => {
    const reordered = { labels: ["bug", "p1"], body: "Steps: ...", title: "Fix flaky retry" };
    expect(issueIdempotencyKey(reordered)).toBe(issueIdempotencyKey(input));
  });

  it("changes when title, body, or labels change", () => {
    const base = issueIdempotencyKey(input);
    expect(issueIdempotencyKey({ ...input, title: "Other" })).not.toBe(base);
    expect(issueIdempotencyKey({ ...input, body: "different" })).not.toBe(base);
    expect(issueIdempotencyKey({ ...input, labels: ["bug"] })).not.toBe(base);
  });

  // The legacy parser yields labels: undefined while batch records may
  // hold []. Both paths MUST hash identically or the legacy fallback
  // (route.ts) escapes idempotency entirely.
  it("treats labels: undefined and labels: [] as the same key", () => {
    const withUndefined = issueIdempotencyKey({ title: "T", body: "B" });
    const withEmpty = issueIdempotencyKey({ title: "T", body: "B", labels: [] });
    expect(withUndefined).toBe(withEmpty);
  });

  it("is insensitive to label order (labels are a set on GitHub)", () => {
    expect(issueIdempotencyKey({ ...input, labels: ["p1", "bug"] })).toBe(
      issueIdempotencyKey(input),
    );
  });
});

describe("executeIdempotent — first execution", () => {
  it("invokes fn exactly once and returns {outcome: created}", async () => {
    const fn = vi.fn(async () => ISSUE);
    const res = await executeIdempotent(KEY, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ outcome: "created", result: ISSUE });
  });

  it("holds the pending lock (nx, 60s TTL) WHILE fn runs", async () => {
    let recordDuringFn: unknown;
    let ttlDuringFn: number | undefined;
    const fn = vi.fn(async () => {
      recordDuringFn = store.get(KEY);
      ttlDuringFn = ttls.get(KEY);
      return ISSUE;
    });
    await executeIdempotent(KEY, fn);
    expect(recordDuringFn).toMatchObject({ status: "pending", lockedAt: NOW });
    expect(ttlDuringFn).toBe(LOCK_TTL_SEC);
    // The lock write must be atomic acquisition, not a blind overwrite.
    expect(vi.mocked(kv.set)).toHaveBeenCalledWith(
      KEY,
      expect.objectContaining({ status: "pending" }),
      expect.objectContaining({ nx: true, ex: LOCK_TTL_SEC }),
    );
  });

  it("persists a completed record with the result and the 30-day TTL", async () => {
    await executeIdempotent(KEY, async () => ISSUE);
    expect(store.get(KEY)).toMatchObject({
      status: "completed",
      result: ISSUE,
      completedAt: NOW,
    });
    expect(ttls.get(KEY)).toBe(COMPLETED_TTL_SEC);
  });
});

describe("executeIdempotent — replay (duplicate execution)", () => {
  it("returns the original result WITHOUT invoking fn again", async () => {
    await executeIdempotent(KEY, async () => ISSUE);
    const fn2 = vi.fn(async () => ({ number: 999, title: "DUP", url: "https://x" }));
    const res = await executeIdempotent(KEY, fn2);
    expect(fn2).not.toHaveBeenCalled();
    expect(res).toEqual({ outcome: "replayed", result: ISSUE });
  });

  it("logs idempotency_replayed", async () => {
    await executeIdempotent(KEY, async () => ISSUE);
    logSpy.mockClear();
    await executeIdempotent(KEY, async () => ISSUE);
    expect(logSpy).toHaveBeenCalledWith(
      "idempotency_replayed",
      expect.objectContaining({ key: KEY }),
    );
  });

  it("invokes fn exactly once across 3 sequential executions of the same key", async () => {
    const fn = vi.fn(async () => ISSUE);
    await executeIdempotent(KEY, fn);
    await executeIdempotent(KEY, fn);
    await executeIdempotent(KEY, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("executeIdempotent — concurrent pending lock", () => {
  it("returns in_flight and does NOT invoke fn when another holder has the lock", async () => {
    store.set(KEY, { status: "pending", lockedAt: NOW - 1_000 });
    const fn = vi.fn(async () => ISSUE);
    const res = await executeIdempotent(KEY, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(res).toEqual({ outcome: "in_flight" });
    expect(logSpy).toHaveBeenCalledWith(
      "idempotency_in_flight",
      expect.objectContaining({ key: KEY }),
    );
  });

  // TOCTOU window: our first get misses, a competitor completes before
  // our NX set. NX loses → the protocol MUST re-read and replay, never
  // give up or re-create. (State re-read after the atomic op.)
  it("re-reads after losing the NX race and replays a competitor's completed result", async () => {
    store.set(KEY, { status: "completed", result: ISSUE, completedAt: NOW - 5_000 });
    vi.mocked(kv.get).mockResolvedValueOnce(null); // simulate the stale first read
    const fn = vi.fn(async () => ISSUE);
    const res = await executeIdempotent(KEY, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(res).toEqual({ outcome: "replayed", result: ISSUE });
  });

  it("resolves to in_flight when the NX race loser finds the competitor still pending", async () => {
    store.set(KEY, { status: "pending", lockedAt: NOW - 2_000 });
    vi.mocked(kv.get).mockResolvedValueOnce(null); // stale first read
    const fn = vi.fn(async () => ISSUE);
    const res = await executeIdempotent(KEY, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(res).toEqual({ outcome: "in_flight" });
  });
});

describe("executeIdempotent — fn failure", () => {
  it("releases the lock, writes no completed record, and rethrows", async () => {
    const boom = new Error("github 500");
    await expect(executeIdempotent(KEY, async () => { throw boom; })).rejects.toThrow(
      "github 500",
    );
    expect(store.has(KEY)).toBe(false); // lock released via del
    expect(vi.mocked(kv.del)).toHaveBeenCalledWith(KEY);
  });

  it("a subsequent execution after failure runs fn again (retryable)", async () => {
    await expect(
      executeIdempotent(KEY, async () => { throw new Error("github 500"); }),
    ).rejects.toThrow();
    const fn = vi.fn(async () => ISSUE);
    const res = await executeIdempotent(KEY, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ outcome: "created", result: ISSUE });
  });
});

describe("executeIdempotent — KV degradation (fail open)", () => {
  it("runs fn once and returns created when the read/lock phase throws; skips record writes", async () => {
    vi.mocked(kv.get).mockRejectedValueOnce(new Error("upstash unreachable"));
    const fn = vi.fn(async () => ISSUE);
    const res = await executeIdempotent(KEY, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ outcome: "created", result: ISSUE });
    expect(vi.mocked(kv.set)).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "idempotency_degraded",
      expect.objectContaining({ key: KEY }),
    );
  });

  it("still returns created (no throw) when only the completed-record write fails", async () => {
    vi.mocked(kv.set)
      .mockResolvedValueOnce("OK") // lock acquisition succeeds
      .mockRejectedValueOnce(new Error("upstash unreachable")); // completed write fails
    const fn = vi.fn(async () => ISSUE);
    const res = await executeIdempotent(KEY, fn);
    expect(res).toEqual({ outcome: "created", result: ISSUE });
    expect(logSpy).toHaveBeenCalledWith(
      "idempotency_degraded",
      expect.objectContaining({ key: KEY }),
    );
  });
});
