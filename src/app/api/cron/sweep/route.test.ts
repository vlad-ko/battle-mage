// ── Sweep claim protocol tests (PR #133 review) ──────────────────────
// The sweep's claim must be NON-DESTRUCTIVE: a failure after a won
// claim (Slack down, thread fetch error) must leave the marker AND its
// index entry intact so the next sweep — after the claim TTL expires —
// can retry the decision. The previous kv.del claim destroyed the
// marker up front, so any later throw silently lost the turn: exactly
// the failure mode #125 exists to prevent.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  const calls: string[] = []; // cross-mock call-order journal
  return {
    calls,
    store: new Map<string, unknown>(),
    zset: new Map<string, number>(), // member -> score
    ttls: new Map<string, number>(),
    rlogSpy: vi.fn(),
    replyInThread: vi.fn(async () => {
      calls.push("replyInThread");
    }),
    fetchThreadMessages: vi.fn(async (): Promise<unknown[]> => {
      calls.push("fetchThreadMessages");
      return [];
    }),
    getBotUserId: vi.fn(async () => "B_BOT"),
    runMentionTurn: vi.fn(async () => {
      calls.push("runMentionTurn");
    }),
    runFollowupTurn: vi.fn(async () => {
      calls.push("runFollowupTurn");
    }),
  };
});

vi.mock("@/lib/kv", () => ({
  kv: {
    get: vi.fn(async (key: string) => (h.store.has(key) ? h.store.get(key) : null)),
    set: vi.fn(
      async (key: string, value: unknown, opts?: { ex?: number; nx?: boolean }) => {
        // Mirror Upstash SET NX semantics: null when the key exists.
        if (opts?.nx && h.store.has(key)) return null;
        h.store.set(key, value);
        if (opts?.ex) h.ttls.set(key, opts.ex);
        h.calls.push(`set:${key}`);
        return "OK";
      },
    ),
    del: vi.fn(async (key: string) => {
      h.calls.push(`del:${key}`);
      return h.store.delete(key) ? 1 : 0;
    }),
    zadd: vi.fn(async (_key: string, entry: { score: number; member: string }) => {
      h.zset.set(entry.member, entry.score);
      return 1;
    }),
    zrem: vi.fn(async (_key: string, member: string) => {
      h.calls.push(`zrem:${member}`);
      return h.zset.delete(member) ? 1 : 0;
    }),
    zrange: vi.fn(async () => [...h.zset.keys()]),
  },
}));

vi.mock("@/lib/logger", () => ({
  log: vi.fn(),
  createRequestLogger: () =>
    Object.assign(
      (event: string, data?: Record<string, unknown>) => h.rlogSpy(event, data),
      { requestId: "req-sweep-1" },
    ),
  flushLogs: vi.fn(async () => {}),
}));

vi.mock("@/lib/slack", () => ({
  replyInThread: h.replyInThread,
  fetchThreadMessages: h.fetchThreadMessages,
  getBotUserId: h.getBotUserId,
}));

vi.mock("@/lib/turn-runner", () => ({
  runMentionTurn: h.runMentionTurn,
  runFollowupTurn: h.runFollowupTurn,
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import {
  processingMarkerKey,
  indexMember,
  sweepClaimKey,
  PROCESSING_MAX_AGE_MS,
  type ProcessingMarker,
} from "@/lib/recovery";
import { GET } from "./route";

// Pinned literals — never faker/random data in fixtures.
const CHANNEL = "C0100000001";
const THREAD_TS = "1750000000.000100";
const MARKER_KEY = processingMarkerKey(CHANNEL, THREAD_TS);
const MEMBER = indexMember(CHANNEL, THREAD_TS);

function seedStaleMarker(
  overrides: Partial<ProcessingMarker> = {},
): ProcessingMarker {
  const m: ProcessingMarker = {
    eventType: "app_mention",
    channel: CHANNEL,
    threadTs: THREAD_TS,
    user: "U0200000002",
    text: "what does the auth module do?",
    startedAt: Date.now() - PROCESSING_MAX_AGE_MS - 60_000,
    attempt: 0,
    requestId: "orig1234",
    ...overrides,
  };
  h.store.set(MARKER_KEY, m);
  h.zset.set(MEMBER, m.startedAt);
  return m;
}

function cronRequest(): NextRequest {
  return new NextRequest("http://localhost/api/cron/sweep", {
    headers: { authorization: "Bearer test-secret" },
  });
}

function rlogEvents(): string[] {
  return h.rlogSpy.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  h.store.clear();
  h.zset.clear();
  h.ttls.clear();
  h.calls.length = 0;
  h.rlogSpy.mockClear();
  h.replyInThread.mockClear();
  h.fetchThreadMessages.mockClear();
  h.runMentionTurn.mockClear();
  h.runFollowupTurn.mockClear();
  process.env.CRON_SECRET = "test-secret";
});

describe("sweep claim (SET NX) — losing racer", () => {
  it("skips the member and leaves marker + index intact when another sweep holds the claim", async () => {
    seedStaleMarker(); // attempt 0 → retry path, but…
    h.store.set(sweepClaimKey(CHANNEL, THREAD_TS), { claimedAt: Date.now(), requestId: "other" });

    const res = await GET(cronRequest());
    expect(res.status).toBe(200);

    expect(rlogEvents()).toContain("recovery_sweep_claim_lost");
    expect(h.store.get(MARKER_KEY)).toBeDefined();
    expect(h.zset.has(MEMBER)).toBe(true);
    expect(h.runMentionTurn).not.toHaveBeenCalled();
    expect(h.replyInThread).not.toHaveBeenCalled();
  });
});

describe("give_up path", () => {
  it("posts the failure notice BEFORE deleting the marker or index entry", async () => {
    seedStaleMarker({ attempt: 1 });

    await GET(cronRequest());

    expect(h.replyInThread).toHaveBeenCalledWith(
      CHANNEL,
      THREAD_TS,
      expect.stringContaining("please re-ask"),
    );
    // Marker + index cleared ONLY AFTER the notice succeeded.
    expect(h.store.has(MARKER_KEY)).toBe(false);
    expect(h.zset.has(MEMBER)).toBe(false);
    const noticeAt = h.calls.indexOf("replyInThread");
    const delAt = h.calls.indexOf(`del:${MARKER_KEY}`);
    const zremAt = h.calls.indexOf(`zrem:${MEMBER}`);
    expect(noticeAt).toBeGreaterThanOrEqual(0);
    expect(delAt).toBeGreaterThan(noticeAt);
    expect(zremAt).toBeGreaterThan(noticeAt);
    expect(rlogEvents()).toContain("recovery_sweep_gave_up");
  });

  it("leaves marker + index intact when the Slack notice fails after a won claim", async () => {
    const marker = seedStaleMarker({ attempt: 1 });
    h.replyInThread.mockRejectedValueOnce(new Error("slack_unreachable"));

    const res = await GET(cronRequest());
    expect(res.status).toBe(200); // per-member catch keeps the sweep alive

    expect(h.store.get(MARKER_KEY)).toEqual(marker);
    expect(h.zset.has(MEMBER)).toBe(true);
    expect(rlogEvents()).toContain("recovery_sweep_member_failed");
    expect(rlogEvents()).not.toContain("recovery_sweep_gave_up");
  });
});

describe("retry path", () => {
  it("leaves the OLD marker + index intact when the already-answered check fails after a won claim", async () => {
    const marker = seedStaleMarker({ attempt: 0 });
    h.fetchThreadMessages.mockRejectedValueOnce(new Error("slack_unreachable"));

    await GET(cronRequest());

    expect(h.store.get(MARKER_KEY)).toEqual(marker);
    expect(h.zset.has(MEMBER)).toBe(true);
    expect(h.runMentionTurn).not.toHaveBeenCalled();
    expect(rlogEvents()).toContain("recovery_sweep_member_failed");
  });

  it("replaces the old marker with the retry marker BEFORE dispatching the turn, then clears it", async () => {
    seedStaleMarker({ attempt: 0 });

    await GET(cronRequest());

    // Crash-window invariant: the retry marker overwrites the SAME key,
    // so at every instant EITHER the old or the new marker exists.
    const markerWriteAt = h.calls.indexOf(`set:${MARKER_KEY}`);
    const turnAt = h.calls.indexOf("runMentionTurn");
    expect(markerWriteAt).toBeGreaterThanOrEqual(0);
    expect(turnAt).toBeGreaterThan(markerWriteAt);
    // No destructive del of the marker before the retry-marker write.
    expect(h.calls.slice(0, markerWriteAt)).not.toContain(`del:${MARKER_KEY}`);

    expect(rlogEvents()).toContain("recovery_sweep_retried");
    // Turn completed → marker + index cleared by the finally.
    expect(h.store.has(MARKER_KEY)).toBe(false);
    expect(h.zset.has(MEMBER)).toBe(false);
  });

  it("clears the marker without retrying when the bot already answered after startedAt", async () => {
    const marker = seedStaleMarker({ attempt: 0 });
    h.fetchThreadMessages.mockResolvedValueOnce([
      {
        user: "B_BOT",
        ts: String((marker.startedAt + 5_000) / 1000),
        text: "Here is the answer.",
      },
    ]);

    await GET(cronRequest());

    expect(h.runMentionTurn).not.toHaveBeenCalled();
    expect(rlogEvents()).toContain("recovery_sweep_already_answered");
    expect(h.store.has(MARKER_KEY)).toBe(false);
    expect(h.zset.has(MEMBER)).toBe(false);
  });
});
