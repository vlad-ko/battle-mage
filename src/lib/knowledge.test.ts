import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn() }));
vi.mock("./logger", () => ({
  log: (...args: unknown[]) => logSpy(...args),
}));

// In-memory zset fake for the kv wrapper. Only the ops knowledge.ts uses.
// `store` maps member JSON → score, mirroring a Redis sorted set.
const { store } = vi.hoisted(() => ({
  store: new Map<string, number>(),
}));

vi.mock("./kv", () => ({
  kv: {
    zadd: vi.fn(async (_key: string, entry: { score: number; member: string }) => {
      const isNew = !store.has(entry.member);
      store.set(entry.member, entry.score);
      return isNew ? 1 : 0;
    }),
    zrem: vi.fn(async (_key: string, member: string) => {
      return store.delete(member) ? 1 : 0;
    }),
    zscore: vi.fn(async (_key: string, member: string) => {
      return store.has(member) ? store.get(member)! : null;
    }),
    zrange: vi.fn(
      async (
        _key: string,
        _start: number,
        _stop: number,
        options?: { rev?: boolean },
      ) => {
        const sorted = [...store.entries()].sort((a, b) => a[1] - b[1]);
        if (options?.rev) sorted.reverse();
        // Mimic @upstash/redis auto-deserialization: JSON members come
        // back as objects, non-JSON members as raw strings (verified
        // against the live instance, #124).
        return sorted.map(([member]) => {
          try {
            return JSON.parse(member);
          } catch {
            return member;
          }
        });
      },
    ),
  },
}));

// ── #127: mock the vector layer (knowledge.ts must treat it as best-effort) ──
const { vectorUpsertSpy, vectorDeleteSpy, vectorQuerySpy } = vi.hoisted(() => ({
  vectorUpsertSpy: vi.fn(),
  vectorDeleteSpy: vi.fn(),
  vectorQuerySpy: vi.fn(),
}));
vi.mock("./vector", () => ({
  vectorUpsert: (...a: unknown[]) => vectorUpsertSpy(...a),
  vectorDelete: (...a: unknown[]) => vectorDeleteSpy(...a),
  vectorQuery: (...a: unknown[]) => vectorQuerySpy(...a),
  kbNamespace: () => "acme/backend:kb",
}));

import {
  saveKnowledgeEntry,
  supersedeKnowledgeEntry,
  markKnowledgeSuperseded,
  archiveKnowledgeEntry,
  getAllKnowledge,
  getKnowledgeHistory,
  getKnowledgeAsMarkdown,
  getKnowledgeRecallAsMarkdown,
  STALE_CONTEXT_FOOTER,
} from "./knowledge";

// Inject a raw member directly, bypassing the public API — used to
// simulate legacy entries written before ids existed.
function injectRawMember(member: string, score: number): void {
  store.set(member, score);
}

import { kv } from "./kv";

beforeEach(() => {
  store.clear();
  logSpy.mockClear();
  vectorUpsertSpy.mockReset().mockResolvedValue(true);
  vectorDeleteSpy.mockReset().mockResolvedValue(true);
  vectorQuerySpy.mockReset().mockResolvedValue(null); // default: vector unavailable
});

describe("saveKnowledgeEntry", () => {
  it("returns a stable non-empty id", async () => {
    const id = await saveKnowledgeEntry("Auth lives in src/lib/auth.ts");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("saved entry is visible with its id and a YYYY-MM-DD timestamp", async () => {
    const id = await saveKnowledgeEntry("The deploy target is Vercel");
    const entries = await getAllKnowledge();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(id);
    expect(entries[0].entry).toBe("The deploy target is Vercel");
    expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("assigns distinct ids to distinct saves", async () => {
    const a = await saveKnowledgeEntry("fact a");
    const b = await saveKnowledgeEntry("fact b");
    expect(a).not.toBe(b);
  });
});

describe("legacy entries (no id field)", () => {
  it("parse as visible entries", async () => {
    injectRawMember(
      JSON.stringify({ entry: "Legacy fact", timestamp: "2025-11-01" }),
      1_700_000_000_000,
    );
    const entries = await getAllKnowledge();
    expect(entries).toHaveLength(1);
    expect(entries[0].entry).toBe("Legacy fact");
    expect(entries[0].id).toBeUndefined();
  });

  it("plain non-JSON string members surface in history without crashing", async () => {
    injectRawMember("bare legacy string entry", 900);
    const history = await getKnowledgeHistory();
    expect(history).toHaveLength(1);
    expect(history[0].entry).toBe("bare legacy string entry");
    expect(history[0].timestamp).toBe("unknown");
  });

  it("can be superseded by matching entry text", async () => {
    injectRawMember(
      JSON.stringify({ entry: "Old legacy fact", timestamp: "2025-11-01" }),
      1_700_000_000_000,
    );
    const newId = await saveKnowledgeEntry("Corrected fact");
    const ok = await markKnowledgeSuperseded("Old legacy fact", newId);
    expect(ok).toBe(true);

    const visible = await getAllKnowledge();
    expect(visible.map((e) => e.entry)).toEqual(["Corrected fact"]);

    const history = await getKnowledgeHistory();
    const old = history.find((e) => e.entry === "Old legacy fact");
    expect(old?.supersededById).toBe(newId);
  });
});

describe("supersedeKnowledgeEntry", () => {
  it("hides the old entry, creates the replacement, and links them", async () => {
    const oldId = await saveKnowledgeEntry("Auth uses sessions");
    const newId = await supersedeKnowledgeEntry(oldId, "Auth uses JWT");
    expect(newId).not.toBeNull();

    const visible = await getAllKnowledge();
    expect(visible.map((e) => e.entry)).toEqual(["Auth uses JWT"]);

    const history = await getKnowledgeHistory();
    const old = history.find((e) => e.id === oldId);
    expect(old?.supersededById).toBe(newId);
  });

  it("returns null and creates nothing when the old entry does not exist", async () => {
    const result = await supersedeKnowledgeEntry("no-such-id", "new text");
    expect(result).toBeNull();
    expect(await getKnowledgeHistory()).toHaveLength(0);
  });

  it("still returns the new id (correction preserved) and logs when linking fails", async () => {
    const oldId = await saveKnowledgeEntry("original");
    // Simulate losing the zrem race: the old member vanishes between
    // the visibility check and the rewrite.
    vi.mocked(kv.zrem).mockResolvedValueOnce(0);

    const newId = await supersedeKnowledgeEntry(oldId, "replacement");
    expect(newId).not.toBeNull();

    const visible = await getAllKnowledge();
    expect(visible.some((e) => e.entry === "replacement")).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(
      "knowledge_supersede_link_failed",
      expect.objectContaining({ newId }),
    );
  });

  it("preserves the superseded entry's zset score so history ordering is stable", async () => {
    const oldId = await saveKnowledgeEntry("original");
    const rawBefore = [...store.entries()].find(([m]) => m.includes("original"));
    expect(rawBefore).toBeDefined();
    const scoreBefore = rawBefore![1];

    await supersedeKnowledgeEntry(oldId, "replacement");

    const rawAfter = [...store.entries()].find(([m]) => m.includes("original"));
    expect(rawAfter).toBeDefined();
    expect(rawAfter![1]).toBe(scoreBefore);
  });
});

describe("markKnowledgeSuperseded", () => {
  it("matches by id", async () => {
    const oldId = await saveKnowledgeEntry("fact to retire");
    const newId = await saveKnowledgeEntry("newer fact");
    expect(await markKnowledgeSuperseded(oldId, newId)).toBe(true);
    const visible = await getAllKnowledge();
    expect(visible.map((e) => e.entry)).toEqual(["newer fact"]);
  });

  it("returns false when no entry matches", async () => {
    expect(await markKnowledgeSuperseded("ghost", "x")).toBe(false);
  });

  it("skips a non-visible first text match and supersedes a later visible duplicate", async () => {
    // Two entries share the same text; the older one is already
    // superseded. Text matching must not stop at the rejected first
    // match — the visible duplicate should be retired.
    injectRawMember(
      JSON.stringify({ id: "a", entry: "dup fact", timestamp: "2025-01-01", supersededById: "x" }),
      1000,
    );
    injectRawMember(
      JSON.stringify({ id: "b", entry: "dup fact", timestamp: "2025-06-01" }),
      2000,
    );
    const ok = await markKnowledgeSuperseded("dup fact", "n1");
    expect(ok).toBe(true);

    const history = await getKnowledgeHistory();
    expect(history.find((e) => e.id === "a")?.supersededById).toBe("x");
    expect(history.find((e) => e.id === "b")?.supersededById).toBe("n1");
  });

  it("never marks an entry as superseded by itself (text collision with its own replacement)", async () => {
    // A correction whose text matches the flagged entry text must not
    // self-link when the old entry is gone and text-matching falls
    // through to the replacement itself.
    const newId = await saveKnowledgeEntry("Auth uses JWT");
    const ok = await markKnowledgeSuperseded("Auth uses JWT", newId);
    expect(ok).toBe(false);
    const entries = await getAllKnowledge();
    expect(entries).toHaveLength(1);
    expect(entries[0].supersededById).toBeUndefined();
  });

  it("is a no-op on an already-superseded entry (does not resurrect or relink)", async () => {
    const oldId = await saveKnowledgeEntry("fact");
    const firstNewId = await saveKnowledgeEntry("first correction");
    await markKnowledgeSuperseded(oldId, firstNewId);
    const ok = await markKnowledgeSuperseded(oldId, "some-other-id");
    expect(ok).toBe(false);
    const history = await getKnowledgeHistory();
    const old = history.find((e) => e.id === oldId);
    expect(old?.supersededById).toBe(firstNewId);
  });
});

describe("archiveKnowledgeEntry", () => {
  it("hides the entry and records reason + archive date", async () => {
    const id = await saveKnowledgeEntry("obsolete fact");
    const ok = await archiveKnowledgeEntry(id, "confirmed stale via 👎");
    expect(ok).toBe(true);

    expect(await getAllKnowledge()).toHaveLength(0);
    const history = await getKnowledgeHistory();
    expect(history).toHaveLength(1);
    expect(history[0].archivedReason).toBe("confirmed stale via 👎");
    expect(history[0].archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns false for an unknown entry", async () => {
    expect(await archiveKnowledgeEntry("nope", "reason")).toBe(false);
  });
});

describe("getAllKnowledge ordering", () => {
  it("returns visible entries newest first by zset score", async () => {
    injectRawMember(JSON.stringify({ entry: "oldest", timestamp: "2025-01-01" }), 1000);
    injectRawMember(JSON.stringify({ entry: "middle", timestamp: "2025-06-01" }), 2000);
    injectRawMember(JSON.stringify({ entry: "newest", timestamp: "2026-01-01" }), 3000);
    const entries = await getAllKnowledge();
    expect(entries.map((e) => e.entry)).toEqual(["newest", "middle", "oldest"]);
  });
});

describe("getKnowledgeAsMarkdown", () => {
  it("renders dated visible entries and ends with the stale-context footer", async () => {
    await saveKnowledgeEntry("KB fact one");
    const md = await getKnowledgeAsMarkdown();
    expect(md).not.toBeNull();
    expect(md!).toContain("KB fact one");
    expect(md!).toMatch(/- \[\d{4}-\d{2}-\d{2}\] KB fact one/);
    expect(md!.trimEnd().endsWith(STALE_CONTEXT_FOOTER)).toBe(true);
  });

  it("excludes superseded entries", async () => {
    const oldId = await saveKnowledgeEntry("stale fact");
    await supersedeKnowledgeEntry(oldId, "fresh fact");
    const md = await getKnowledgeAsMarkdown();
    expect(md!).toContain("fresh fact");
    expect(md!).not.toContain("stale fact");
  });

  it("returns null when no visible entries remain", async () => {
    const id = await saveKnowledgeEntry("only fact");
    await archiveKnowledgeEntry(id, "cleanup");
    expect(await getKnowledgeAsMarkdown()).toBeNull();
  });

  it("returns null when the KB is empty", async () => {
    expect(await getKnowledgeAsMarkdown()).toBeNull();
  });
});

describe("saveKnowledgeEntry — vector embedding (#127)", () => {
  it("upserts the entry into the KB namespace keyed by its id, with text and timestamp metadata", async () => {
    const id = await saveKnowledgeEntry("Auth lives in src/lib/auth.ts");
    expect(vectorUpsertSpy).toHaveBeenCalledWith("acme/backend:kb", [
      expect.objectContaining({
        id,
        text: "Auth lives in src/lib/auth.ts",
        metadata: expect.objectContaining({
          timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      }),
    ]);
  });

  it("save succeeds and returns the id when embedding reports failure", async () => {
    vectorUpsertSpy.mockResolvedValue(false);
    const id = await saveKnowledgeEntry("fact survives embed failure");
    expect(id.length).toBeGreaterThan(0);
    expect((await getAllKnowledge()).map((e) => e.entry)).toContain(
      "fact survives embed failure",
    );
  });

  it("save succeeds even if the vector layer rejects (contract-violation guard)", async () => {
    vectorUpsertSpy.mockRejectedValue(new Error("should never happen"));
    const id = await saveKnowledgeEntry("fact survives embed crash");
    expect(id.length).toBeGreaterThan(0);
    expect(await getAllKnowledge()).toHaveLength(1);
  });
});

describe("retire flows remove KB vectors (#127)", () => {
  it("supersedeKnowledgeEntry best-effort-deletes the OLD entry's vector", async () => {
    const oldId = await saveKnowledgeEntry("stale fact");
    await supersedeKnowledgeEntry(oldId, "fresh fact");
    expect(vectorDeleteSpy).toHaveBeenCalledWith("acme/backend:kb", [oldId]);
  });

  it("archiveKnowledgeEntry best-effort-deletes the entry's vector", async () => {
    const id = await saveKnowledgeEntry("obsolete fact");
    await archiveKnowledgeEntry(id, "cleanup");
    expect(vectorDeleteSpy).toHaveBeenCalledWith("acme/backend:kb", [id]);
  });

  it("retire still succeeds when vector delete fails", async () => {
    vectorDeleteSpy.mockResolvedValue(false);
    const id = await saveKnowledgeEntry("fact");
    expect(await archiveKnowledgeEntry(id, "reason")).toBe(true);
    expect(await getAllKnowledge()).toHaveLength(0);
  });
});

describe("getKnowledgeRecallAsMarkdown (#127)", () => {
  // Deterministic fixture: 6 visible entries injected with explicit
  // scores (1000 oldest → 6000 newest) and pinned timestamps.
  function injectSixEntries(): void {
    const rows = [
      { id: "e1", entry: "The Redis KV wrapper lives in src/lib/kv.ts", timestamp: "2026-06-01" },
      { id: "e2", entry: "Deploys go through Vercel only", timestamp: "2026-06-02" },
      { id: "e3", entry: "Issue creation requires a confirmation reaction", timestamp: "2026-06-03" },
      { id: "e4", entry: "The redis client is @upstash/redis behind the kv wrapper", timestamp: "2026-06-04" },
      { id: "e5", entry: "Progress messages are deleted when the answer posts", timestamp: "2026-06-05" },
      { id: "e6", entry: "Slack replies are thread-only, never channel root", timestamp: "2026-06-06" },
    ];
    rows.forEach((r, i) => injectRawMember(JSON.stringify(r), (i + 1) * 1000));
  }

  it("returns null for an empty KB", async () => {
    expect(await getKnowledgeRecallAsMarkdown("anything")).toBeNull();
  });

  it("KB at or below RECALL_TOP_K renders ALL entries and never queries the vector store", async () => {
    await saveKnowledgeEntry("fact a");
    await saveKnowledgeEntry("fact b");
    await saveKnowledgeEntry("fact c");
    const md = await getKnowledgeRecallAsMarkdown("unrelated question");
    expect(md).toContain("fact a");
    expect(md).toContain("fact b");
    expect(md).toContain("fact c");
    expect(vectorQuerySpy).not.toHaveBeenCalled();
    expect(md!.trimEnd().endsWith(STALE_CONTEXT_FOOTER)).toBe(true);
  });

  it("queries the vector arm with the question and MAX_ARM_RESULTS when KB exceeds RECALL_TOP_K", async () => {
    injectSixEntries();
    await getKnowledgeRecallAsMarkdown("where is the redis wrapper");
    expect(vectorQuerySpy).toHaveBeenCalledWith(
      "acme/backend:kb",
      "where is the redis wrapper",
      10, // MAX_ARM_RESULTS
    );
  });

  it("vector unavailable (null) → lexical-only recall still returns the matching entries", async () => {
    injectSixEntries();
    vectorQuerySpy.mockResolvedValue(null);
    const md = await getKnowledgeRecallAsMarkdown("where is the redis wrapper");
    expect(md).toContain("kv.ts");            // e1
    expect(md).toContain("@upstash/redis");   // e4
    expect(md).not.toContain("thread-only");  // e6: no lexical match, no vector arm
    // Only the 2 lexical matches render — no padding.
    expect(md!.match(/^- \[/gm)).toHaveLength(2);
  });

  it("vector-only recall works when the question shares no keywords (semantic hit)", async () => {
    injectSixEntries();
    vectorQuerySpy.mockResolvedValue([
      { id: "e5", score: 0.9 },
      { id: "e2", score: 0.8 },
    ]);
    const md = await getKnowledgeRecallAsMarkdown("zzzq wwwk"); // no lexical overlap
    const lines = md!.match(/^- \[.*$/gm)!;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Progress messages"); // e5 ranked first
    expect(lines[1]).toContain("Vercel only");       // e2 second
  });

  it("K1 invariant: retired and unknown ids from the vector arm never surface", async () => {
    injectSixEntries();
    injectRawMember(
      JSON.stringify({ id: "dead", entry: "superseded ghost fact", timestamp: "2026-01-01", supersededById: "e1" }),
      500,
    );
    vectorQuerySpy.mockResolvedValue([
      { id: "dead", score: 0.99 },     // superseded — must be filtered
      { id: "ghost-404", score: 0.98 }, // not in KV at all — must be filtered
      { id: "e3", score: 0.9 },
    ]);
    const md = await getKnowledgeRecallAsMarkdown("zzzq wwwk");
    expect(md).not.toContain("ghost fact");
    expect(md).toContain("confirmation reaction"); // e3 survives
    expect(md!.match(/^- \[/gm)).toHaveLength(1);
  });

  it("both arms empty → falls back to the newest RECALL_TOP_K entries", async () => {
    injectSixEntries();
    vectorQuerySpy.mockResolvedValue([]); // available, zero matches
    const md = await getKnowledgeRecallAsMarkdown("zzzq wwwk");
    const lines = md!.match(/^- \[.*$/gm)!;
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("thread-only");     // e6, newest by score
    expect(md).not.toContain("src/lib/kv.ts");     // e1, oldest, dropped
  });

  it("prompt-size bound: 50 matching entries still render exactly RECALL_TOP_K lines", async () => {
    for (let i = 0; i < 50; i++) {
      injectRawMember(
        JSON.stringify({ id: `v${i}`, entry: `vercel deployment note ${i}`, timestamp: "2026-06-01" }),
        1000 + i,
      );
    }
    const md = await getKnowledgeRecallAsMarkdown("vercel deployment");
    expect(md!.match(/^- \[/gm)).toHaveLength(5);
    expect(md!.trimEnd().endsWith(STALE_CONTEXT_FOOTER)).toBe(true);
  });
});
