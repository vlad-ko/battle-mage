import { describe, it, expect, vi, beforeEach } from "vitest";

// PR #139 review findings — orchestration-level pins:
// - the sweep scans a BOUNDED window of the discovery zset;
// - a supersession failure never misreports a durably-saved entry.

const mocks = vi.hoisted(() => ({
  kv: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    zadd: vi.fn(),
    zrange: vi.fn(),
    zrem: vi.fn(),
    zscore: vi.fn(),
  },
  replyInThread: vi.fn(),
  fetchThreadMessages: vi.fn(),
  fetchThreadTail: vi.fn(),
  getBotUserId: vi.fn(),
  conversationsInfo: vi.fn(),
  saveKnowledgeEntry: vi.fn(),
  markKnowledgeSuperseded: vi.fn(),
  getAllKnowledge: vi.fn(),
}));

vi.mock("./kv", () => ({ kv: mocks.kv }));
vi.mock("./slack", () => ({
  slack: { conversations: { info: mocks.conversationsInfo } },
  replyInThread: mocks.replyInThread,
  fetchThreadMessages: mocks.fetchThreadMessages,
  fetchThreadTail: mocks.fetchThreadTail,
  getBotUserId: mocks.getBotUserId,
}));
vi.mock("./knowledge", () => ({
  saveKnowledgeEntry: mocks.saveKnowledgeEntry,
  markKnowledgeSuperseded: mocks.markKnowledgeSuperseded,
  getAllKnowledge: mocks.getAllKnowledge,
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { runKbExtractionSweep, executeKbBatchSave } from "./kb-runner";
import {
  KB_EXTRACT_INDEX_KEY,
  KB_EXTRACT_SCAN_LIMIT,
  type PendingKbBatch,
} from "./kb-proposals";
import type { RequestLogger } from "./logger";

function makeRlog(): { rlog: RequestLogger; events: [string, Record<string, unknown> | undefined][] } {
  const events: [string, Record<string, unknown> | undefined][] = [];
  const fn = (event: string, data?: Record<string, unknown>) => {
    events.push([event, data]);
  };
  return { rlog: Object.assign(fn, { requestId: "req-test" }), events };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runKbExtractionSweep — bounded index scan (PR #139)", () => {
  it("reads only the first KB_EXTRACT_SCAN_LIMIT members, oldest-activity first", async () => {
    mocks.kv.zrange.mockResolvedValue([]);
    const { rlog } = makeRlog();

    await runKbExtractionSweep(rlog);

    // zrange default order is ascending by score (= last activity), so
    // the window holds the MOST IDLE threads — exactly the extract/
    // prune candidates. A full-index (0, -1) scan is O(n) per sweep.
    expect(mocks.kv.zrange).toHaveBeenCalledWith(
      KB_EXTRACT_INDEX_KEY,
      0,
      KB_EXTRACT_SCAN_LIMIT - 1,
    );
  });

  it("KB_EXTRACT_SCAN_LIMIT is 50", () => {
    expect(KB_EXTRACT_SCAN_LIMIT).toBe(50);
  });
});

describe("executeKbBatchSave — supersession failure is best-effort (PR #139)", () => {
  const BATCH: PendingKbBatch = {
    candidates: [
      {
        entry: "The auth module lives in app/Services/Auth",
        kind: "correction",
        evidence: [1],
        confidence: 0.9,
        hash: "h1",
        flaggedKbEntries: ["Auth uses JWT in app/Http/Auth"],
        evidenceQuotes: ["moved last quarter"],
      },
    ],
    proposedAt: 1_752_000_000_000,
    channel: "C1",
    threadTs: "17.1",
    messageFirstTs: "17.2",
  };

  function armKv() {
    mocks.kv.get.mockImplementation(async (key: string) => {
      if (key.startsWith("pending-kb-batch:C1:")) return BATCH;
      return null; // state key, etc.
    });
    mocks.kv.del.mockResolvedValue(1);
    mocks.kv.set.mockResolvedValue("OK");
  }

  it("still reports the entry as SAVED when markKnowledgeSuperseded throws, and logs kb_supersede_error", async () => {
    armKv();
    mocks.saveKnowledgeEntry.mockResolvedValue("id-1");
    mocks.markKnowledgeSuperseded.mockRejectedValue(new Error("kv down"));
    const { rlog, events } = makeRlog();

    const result = await executeKbBatchSave("C1", "17.1", "17.2", "U1", "reaction", rlog);

    expect(result).toEqual({ claimed: true });
    // The entry WAS durably saved — a retire failure must not flip the
    // outcome to error (mirrors the 👎 flow's best-effort semantics).
    const saved = events.find(([e]) => e === "kb_batch_saved");
    expect(saved?.[1]).toMatchObject({ successCount: 1, failureCount: 0 });
    expect(events).toContainEqual([
      "kb_supersede_error",
      expect.objectContaining({ channel: "C1", threadTs: "17.1" }),
    ]);
    const summary = mocks.replyInThread.mock.calls.at(-1)?.[2] as string;
    expect(summary).toContain("Saved 1");
    expect(summary).not.toContain(":warning:");
    expect(summary).not.toContain("retired");
  });

  it("counts only successful supersessions when some flagged entries fail", async () => {
    armKv();
    const batch: PendingKbBatch = {
      ...BATCH,
      candidates: [
        {
          ...BATCH.candidates[0],
          flaggedKbEntries: ["stale one", "stale two"],
        },
      ],
    };
    mocks.kv.get.mockImplementation(async (key: string) => {
      if (key.startsWith("pending-kb-batch:C1:")) return batch;
      return null;
    });
    mocks.saveKnowledgeEntry.mockResolvedValue("id-1");
    mocks.markKnowledgeSuperseded
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("boom"));
    const { rlog, events } = makeRlog();

    await executeKbBatchSave("C1", "17.1", "17.2", "U1", "text", rlog);

    const saved = events.find(([e]) => e === "kb_batch_saved");
    expect(saved?.[1]).toMatchObject({ successCount: 1, supersededTotal: 1 });
    const summary = mocks.replyInThread.mock.calls.at(-1)?.[2] as string;
    expect(summary).toContain("retired 1");
  });
});
