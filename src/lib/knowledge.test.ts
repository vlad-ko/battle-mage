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

import {
  saveKnowledgeEntry,
  supersedeKnowledgeEntry,
  markKnowledgeSuperseded,
  archiveKnowledgeEntry,
  getAllKnowledge,
  getKnowledgeHistory,
  getKnowledgeAsMarkdown,
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
