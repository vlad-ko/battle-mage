import { describe, it, expect, vi, beforeEach } from "vitest";

const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn() }));
vi.mock("./logger", () => ({
  log: (...args: unknown[]) => logSpy(...args),
}));

const { store, zset, ttls } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  zset: new Map<string, number>(), // member -> score
  ttls: new Map<string, number>(),
}));

vi.mock("./kv", () => ({
  kv: {
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    set: vi.fn(async (key: string, value: unknown, opts?: { ex?: number; nx?: boolean }) => {
      // Mirror Upstash SET NX semantics: null when the key already exists.
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      if (opts?.ex) ttls.set(key, opts.ex);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    zadd: vi.fn(async (_key: string, entry: { score: number; member: string }) => {
      const isNew = !zset.has(entry.member);
      zset.set(entry.member, entry.score);
      return isNew ? 1 : 0;
    }),
    zrem: vi.fn(async (_key: string, member: string) => (zset.delete(member) ? 1 : 0)),
    zrange: vi.fn(async () => [...zset.keys()]),
  },
}));

import { kv } from "./kv";
import {
  processingMarkerKey,
  indexMember,
  parseIndexMember,
  decideSweepAction,
  buildRetryMarker,
  isAuthorizedCronRequest,
  writeProcessingMarker,
  clearProcessingMarker,
  sweepClaimKey,
  acquireSweepClaim,
  PROCESSING_INDEX_KEY,
  PROCESSING_MARKER_TTL_SEC,
  PROCESSING_MAX_AGE_MS,
  SLACK_ROUTE_MAX_DURATION_SEC,
  SWEEP_CLAIM_TTL_SEC,
  type ProcessingMarker,
} from "./recovery";

// Pinned literals — never faker/random data in fixtures.
const NOW = 1_750_000_000_000;
const CHANNEL = "C0100000001";
const THREAD_TS = "1750000000.000100";

function marker(overrides: Partial<ProcessingMarker> = {}): ProcessingMarker {
  return {
    eventType: "app_mention",
    channel: CHANNEL,
    threadTs: THREAD_TS,
    user: "U0200000002",
    text: "what does the auth module do?",
    startedAt: NOW - PROCESSING_MAX_AGE_MS - 1,
    attempt: 0,
    requestId: "abcd1234",
    ...overrides,
  };
}

beforeEach(() => {
  store.clear();
  zset.clear();
  ttls.clear();
  logSpy.mockClear();
  vi.mocked(kv.set).mockClear();
  vi.mocked(kv.del).mockClear();
  vi.mocked(kv.zadd).mockClear();
  vi.mocked(kv.zrem).mockClear();
});

describe("constants (pinned — acceptance criteria of #125)", () => {
  it("marker safety TTL is 24h", () => {
    expect(PROCESSING_MARKER_TTL_SEC).toBe(86_400);
  });

  it("max-age is 15 minutes", () => {
    expect(PROCESSING_MAX_AGE_MS).toBe(900_000);
  });

  it("index key is the fixed discovery zset", () => {
    expect(PROCESSING_INDEX_KEY).toBe("processing:index");
  });

  // Invariant I4: a marker older than max-age CANNOT belong to a live
  // invocation. This is the structural guard against the sweep
  // double-answering a still-running turn. If either constant moves,
  // this test forces the reviewer to re-verify the invariant.
  it("max-age strictly exceeds the Slack route maxDuration", () => {
    expect(PROCESSING_MAX_AGE_MS).toBeGreaterThan(SLACK_ROUTE_MAX_DURATION_SEC * 1000);
  });

  // Non-destructive sweep claim (PR #133 review). 120s must comfortably
  // cover one member's action: thread fetch + reply + marker rewrite.
  it("sweep-claim TTL is 120 seconds", () => {
    expect(SWEEP_CLAIM_TTL_SEC).toBe(120);
  });

  // If the claim outlived marker staleness, an abandoned claim could
  // block recovery longer than a whole staleness cycle.
  it("sweep-claim TTL is well below marker max-age", () => {
    expect(SWEEP_CLAIM_TTL_SEC * 1000).toBeLessThan(PROCESSING_MAX_AGE_MS);
  });
});

describe("sweepClaimKey (pure)", () => {
  it("builds processing:claim:<channel>:<threadTs>", () => {
    expect(sweepClaimKey(CHANNEL, THREAD_TS)).toBe(
      `processing:claim:${CHANNEL}:${THREAD_TS}`,
    );
  });

  it("kv_op log bucket (first segment) is 'processing'", () => {
    expect(sweepClaimKey(CHANNEL, THREAD_TS).split(":")[0]).toBe("processing");
  });
});

describe("acquireSweepClaim (NX semantics, mocked kv)", () => {
  it("first claimer wins and the claim carries the TTL", async () => {
    const won = await acquireSweepClaim(CHANNEL, THREAD_TS, "req-a");
    expect(won).toBe(true);
    expect(store.has(sweepClaimKey(CHANNEL, THREAD_TS))).toBe(true);
    expect(ttls.get(sweepClaimKey(CHANNEL, THREAD_TS))).toBe(SWEEP_CLAIM_TTL_SEC);
  });

  it("second claimer loses while the first claim is live (NX)", async () => {
    expect(await acquireSweepClaim(CHANNEL, THREAD_TS, "req-a")).toBe(true);
    expect(await acquireSweepClaim(CHANNEL, THREAD_TS, "req-b")).toBe(false);
  });

  it("claims on different threads are independent", async () => {
    expect(await acquireSweepClaim(CHANNEL, THREAD_TS, "req-a")).toBe(true);
    expect(await acquireSweepClaim(CHANNEL, "1750000099.000200", "req-a")).toBe(true);
  });

  it("does NOT touch the marker or its index entry (non-destructive)", async () => {
    await writeProcessingMarker(marker({ startedAt: NOW }));
    await acquireSweepClaim(CHANNEL, THREAD_TS, "req-a");
    expect(store.has(processingMarkerKey(CHANNEL, THREAD_TS))).toBe(true);
    expect(zset.has(indexMember(CHANNEL, THREAD_TS))).toBe(true);
  });
});

describe("processingMarkerKey / index member (pure)", () => {
  it("builds processing:<channel>:<threadTs>", () => {
    expect(processingMarkerKey(CHANNEL, THREAD_TS)).toBe(
      `processing:${CHANNEL}:${THREAD_TS}`,
    );
  });

  it("kv_op log bucket (first segment) is 'processing'", () => {
    expect(processingMarkerKey(CHANNEL, THREAD_TS).split(":")[0]).toBe("processing");
  });

  it("index member round-trips channel and threadTs", () => {
    const member = indexMember(CHANNEL, THREAD_TS);
    expect(parseIndexMember(member)).toEqual({ channel: CHANNEL, threadTs: THREAD_TS });
  });
});

describe("decideSweepAction (pure) — staleness boundary", () => {
  // Stale is defined as: now - startedAt > maxAgeMs (STRICTLY greater).
  it("returns wait just under max-age", () => {
    const m = marker({ startedAt: NOW - PROCESSING_MAX_AGE_MS + 1 });
    expect(decideSweepAction(m, NOW, PROCESSING_MAX_AGE_MS)).toBe("wait");
  });

  it("returns wait at exactly max-age (boundary is exclusive)", () => {
    const m = marker({ startedAt: NOW - PROCESSING_MAX_AGE_MS });
    expect(decideSweepAction(m, NOW, PROCESSING_MAX_AGE_MS)).toBe("wait");
  });

  it("returns retry one millisecond past max-age on the first attempt", () => {
    const m = marker({ startedAt: NOW - PROCESSING_MAX_AGE_MS - 1, attempt: 0 });
    expect(decideSweepAction(m, NOW, PROCESSING_MAX_AGE_MS)).toBe("retry");
  });

  it("returns give_up past max-age once a retry has been consumed", () => {
    const m = marker({ attempt: 1 });
    expect(decideSweepAction(m, NOW, PROCESSING_MAX_AGE_MS)).toBe("give_up");
  });

  it("returns give_up for any attempt count above 1 (defensive)", () => {
    const m = marker({ attempt: 2 });
    expect(decideSweepAction(m, NOW, PROCESSING_MAX_AGE_MS)).toBe("give_up");
  });

  it("returns wait when startedAt is in the future (clock skew must not trigger retries)", () => {
    const m = marker({ startedAt: NOW + 60_000 });
    expect(decideSweepAction(m, NOW, PROCESSING_MAX_AGE_MS)).toBe("wait");
  });

  it("returns orphan for a missing marker record (index entry outlived the 24h marker TTL)", () => {
    expect(decideSweepAction(null, NOW, PROCESSING_MAX_AGE_MS)).toBe("orphan");
  });

  it("defaults maxAgeMs to PROCESSING_MAX_AGE_MS", () => {
    expect(decideSweepAction(marker(), NOW)).toBe("retry");
  });
});

describe("buildRetryMarker (pure)", () => {
  it("increments attempt, refreshes startedAt, preserves the event payload", () => {
    const original = marker();
    const retry = buildRetryMarker(original, NOW);
    expect(retry).toEqual({
      eventType: "app_mention",
      channel: CHANNEL,
      threadTs: THREAD_TS,
      user: "U0200000002",
      text: "what does the auth module do?",
      startedAt: NOW,
      attempt: 1,
      requestId: "abcd1234", // kept for cross-run correlation
    });
  });

  it("does not mutate the input marker", () => {
    const original = marker();
    buildRetryMarker(original, NOW);
    expect(original.attempt).toBe(0);
    expect(original.startedAt).toBe(NOW - PROCESSING_MAX_AGE_MS - 1);
  });
});

describe("isAuthorizedCronRequest (pure)", () => {
  it("accepts the exact Bearer token", () => {
    expect(isAuthorizedCronRequest("Bearer s3cret", "s3cret")).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(isAuthorizedCronRequest("Bearer wrong", "s3cret")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(isAuthorizedCronRequest(null, "s3cret")).toBe(false);
  });

  it("rejects a token without the Bearer prefix", () => {
    expect(isAuthorizedCronRequest("s3cret", "s3cret")).toBe(false);
  });

  it("rejects a lowercase 'bearer' prefix (exact scheme match)", () => {
    expect(isAuthorizedCronRequest("bearer s3cret", "s3cret")).toBe(false);
  });

  it("denies ALL requests when CRON_SECRET is unset (fail closed)", () => {
    expect(isAuthorizedCronRequest("Bearer anything", undefined)).toBe(false);
  });

  it("denies ALL requests when CRON_SECRET is empty", () => {
    expect(isAuthorizedCronRequest("Bearer ", "")).toBe(false);
  });
});

describe("writeProcessingMarker (marker lifecycle, mocked kv)", () => {
  it("persists the marker under its key with the 24h TTL and indexes it by startedAt", async () => {
    const m = marker({ startedAt: NOW });
    const ok = await writeProcessingMarker(m);
    expect(ok).toBe(true);
    const key = processingMarkerKey(CHANNEL, THREAD_TS);
    expect(store.get(key)).toEqual(m);
    expect(ttls.get(key)).toBe(PROCESSING_MARKER_TTL_SEC);
    expect(zset.get(indexMember(CHANNEL, THREAD_TS))).toBe(NOW);
  });

  it("returns false and logs recovery_marker_write_failed on KV failure — never throws", async () => {
    vi.mocked(kv.set).mockRejectedValueOnce(new Error("upstash unreachable"));
    const ok = await writeProcessingMarker(marker({ startedAt: NOW }));
    expect(ok).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(
      "recovery_marker_write_failed",
      expect.objectContaining({ channel: CHANNEL, threadTs: THREAD_TS }),
    );
  });
});

describe("clearProcessingMarker (marker lifecycle, mocked kv)", () => {
  it("deletes the marker and removes the index member", async () => {
    await writeProcessingMarker(marker({ startedAt: NOW }));
    await clearProcessingMarker(CHANNEL, THREAD_TS);
    expect(store.has(processingMarkerKey(CHANNEL, THREAD_TS))).toBe(false);
    expect(zset.has(indexMember(CHANNEL, THREAD_TS))).toBe(false);
  });

  it("swallows KV failures and logs recovery_marker_clear_failed — a clear failure must never break the reply flow", async () => {
    vi.mocked(kv.del).mockRejectedValueOnce(new Error("upstash unreachable"));
    await expect(clearProcessingMarker(CHANNEL, THREAD_TS)).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      "recovery_marker_clear_failed",
      expect.objectContaining({ channel: CHANNEL, threadTs: THREAD_TS }),
    );
  });
});
