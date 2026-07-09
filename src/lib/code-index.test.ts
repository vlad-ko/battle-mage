// ── Incremental semantic code index (#135) ───────────────────────────
// Part A pins the pure diff/id helpers; Part B drives runCodeIndexTick
// through the hoisted harness: an in-memory kv fake with Upstash
// SET NX → null semantics, a mocked vector layer with a cross-mock
// call-order journal, and mocked GitHub reads pinned to the tick's
// tree snapshot SHA.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BattleMageConfig } from "./config";

const h = vi.hoisted(() => {
  const callOrder: string[] = [];
  return {
    callOrder,
    kvData: new Map<string, unknown>(),
    logSpy: vi.fn((..._args: unknown[]) => {}),
    getHeadShaSpy: vi.fn(),
    getRepoTreeSnapshotSpy: vi.fn(),
    readFileSpy: vi.fn(),
    isVectorConfiguredMock: vi.fn((..._args: unknown[]) => true),
    vectorUpsertSpy: vi.fn(async (..._args: unknown[]) => {
      callOrder.push("vectorUpsert");
      return true;
    }),
    vectorDeleteSpy: vi.fn(async (..._args: unknown[]) => {
      callOrder.push("vectorDelete");
      return true;
    }),
  };
});

vi.mock("./kv", () => ({
  kv: {
    get: vi.fn(async (key: string) =>
      h.kvData.has(key) ? h.kvData.get(key) : null,
    ),
    set: vi.fn(
      async (key: string, value: unknown, opts?: { ex?: number; nx?: boolean }) => {
        // Mirror Upstash SET NX semantics: null when the key exists.
        if (opts?.nx && h.kvData.has(key)) return null;
        h.kvData.set(key, value);
        return "OK";
      },
    ),
    del: vi.fn(async (key: string) => (h.kvData.delete(key) ? 1 : 0)),
  },
}));

vi.mock("./logger", () => ({
  log: (...args: unknown[]) => h.logSpy(...args),
}));

vi.mock("./vector", () => ({
  isVectorConfigured: (...args: unknown[]) => h.isVectorConfiguredMock(...args),
  srcNamespace: () => "acme_backend:src",
  docsNamespace: (sha: string) => `acme_backend:docs:${sha}`,
  kbNamespace: () => "acme_backend:kb",
  vectorUpsert: (...args: unknown[]) => h.vectorUpsertSpy(...args),
  vectorDelete: (...args: unknown[]) => h.vectorDeleteSpy(...args),
  vectorDeleteNamespace: vi.fn(async () => true),
}));

vi.mock("@/lib/github", () => ({
  getHeadSha: (...args: unknown[]) => h.getHeadShaSpy(...args),
  getRepoTreeSnapshot: (...args: unknown[]) => h.getRepoTreeSnapshotSpy(...args),
  readFile: (...args: unknown[]) => h.readFileSpy(...args),
}));

import {
  diffTreeAgainstManifest,
  chunkIdsFor,
  staleChunkIds,
  runCodeIndexTick,
  MAX_FILES_PER_TICK,
  SRC_INDEX_CLAIM_TTL_SEC,
  CODE_INDEX_ROUTE_MAX_DURATION_SEC,
  type SrcManifest,
} from "./code-index";
import { MAX_EMBED_FILE_BYTES } from "./code-chunker";

const {
  kvData,
  logSpy,
  getHeadShaSpy,
  getRepoTreeSnapshotSpy,
  readFileSpy,
  isVectorConfiguredMock,
  vectorUpsertSpy,
  vectorDeleteSpy,
  callOrder,
} = h;

// ── Part A — pure functions, no mocks ────────────────────────────────

describe("diffTreeAgainstManifest", () => {
  const config: BattleMageConfig = { paths: { "vendor/": "vendor" } };

  it("first run (empty manifest): every eligible blob is an upsert, nothing deleted", () => {
    const blobs = [
      { path: "src/a.ts", sha: "sha-a", size: 10 },
      { path: "docs/x.md", sha: "sha-x", size: 10 }, // ineligible ext
      { path: "vendor/l.php", sha: "sha-v", size: 10 }, // vendor
    ];
    const diff = diffTreeAgainstManifest(blobs, {}, config);
    expect(diff.toUpsert).toEqual([{ path: "src/a.ts", sha: "sha-a", size: 10 }]);
    expect(diff.toDelete).toEqual([]);
  });

  it("unchanged blob sha → no work; changed sha → upsert; missing path → delete with old chunk count", () => {
    const manifest = {
      "src/a.ts": { sha: "sha-a", chunks: 2 },
      "src/b.ts": { sha: "sha-b-old", chunks: 3 },
      "src/gone.ts": { sha: "sha-g", chunks: 4 },
    };
    const blobs = [
      { path: "src/a.ts", sha: "sha-a", size: 10 },
      { path: "src/b.ts", sha: "sha-b-new", size: 10 },
    ];
    const diff = diffTreeAgainstManifest(blobs, manifest, { paths: {} });
    expect(diff.toUpsert).toEqual([{ path: "src/b.ts", sha: "sha-b-new", size: 10 }]);
    expect(diff.toDelete).toEqual([{ path: "src/gone.ts", chunks: 4 }]);
  });

  it("S6: a manifest path that BECAME ineligible (config now marks it vendor) moves to the delete side", () => {
    const manifest = { "vendor/l.php": { sha: "sha-v", chunks: 2 } };
    const blobs = [{ path: "vendor/l.php", sha: "sha-v", size: 10 }];
    const diff = diffTreeAgainstManifest(blobs, manifest, config);
    expect(diff.toUpsert).toEqual([]);
    expect(diff.toDelete).toEqual([{ path: "vendor/l.php", chunks: 2 }]);
  });

  it("oversize blob never enters the upsert side; if previously indexed it is deleted", () => {
    const manifest = { "src/big.ts": { sha: "old", chunks: 9 } };
    const blobs = [{ path: "src/big.ts", sha: "new", size: MAX_EMBED_FILE_BYTES + 1 }];
    const diff = diffTreeAgainstManifest(blobs, manifest, { paths: {} });
    expect(diff.toUpsert).toEqual([]);
    expect(diff.toDelete).toEqual([{ path: "src/big.ts", chunks: 9 }]);
  });
});

describe("chunkIdsFor / staleChunkIds", () => {
  it("chunkIdsFor(path, 3) → ordinals 0..2; count 0 → []", () => {
    expect(chunkIdsFor("src/a.ts", 3)).toEqual(["src/a.ts#0", "src/a.ts#1", "src/a.ts#2"]);
    expect(chunkIdsFor("src/a.ts", 0)).toEqual([]);
  });

  it("staleChunkIds trims only the shrink tail; growth and equality trim nothing", () => {
    expect(staleChunkIds("src/a.ts", 5, 3)).toEqual(["src/a.ts#3", "src/a.ts#4"]);
    expect(staleChunkIds("src/a.ts", 3, 3)).toEqual([]);
    expect(staleChunkIds("src/a.ts", 3, 5)).toEqual([]);
  });
});

describe("timing invariants (mirror of recovery I4 pinning)", () => {
  it("claim TTL exceeds route maxDuration and stays under the 300s cron cadence", () => {
    expect(SRC_INDEX_CLAIM_TTL_SEC).toBeGreaterThan(CODE_INDEX_ROUTE_MAX_DURATION_SEC);
    expect(SRC_INDEX_CLAIM_TTL_SEC).toBeLessThan(300);
  });
});

// ── Part B — runCodeIndexTick ────────────────────────────────────────

beforeEach(() => {
  kvData.clear();
  callOrder.length = 0;
  logSpy.mockClear();
  getHeadShaSpy.mockReset();
  getRepoTreeSnapshotSpy.mockReset();
  readFileSpy.mockReset();
  isVectorConfiguredMock.mockReset().mockReturnValue(true);
  vectorUpsertSpy.mockReset().mockImplementation(async () => {
    callOrder.push("vectorUpsert");
    return true;
  });
  vectorDeleteSpy.mockReset().mockImplementation(async () => {
    callOrder.push("vectorDelete");
    return true;
  });
});

describe("runCodeIndexTick", () => {
  it("noop fast path: headSha === srcindex:sha → no tree fetch, no claim held afterward, src_index_noop", async () => {
    kvData.set("srcindex:sha", "sha-1");
    getHeadShaSpy.mockResolvedValue("sha-1");
    const result = await runCodeIndexTick();
    expect(result.status).toBe("noop");
    expect(getRepoTreeSnapshotSpy).not.toHaveBeenCalled();
    expect(kvData.has("srcindex:claim")).toBe(false);
    expect(logSpy).toHaveBeenCalledWith("src_index_noop", expect.objectContaining({ sha: "sha-1" }));
  });

  it("claim lost: existing srcindex:claim → skips ALL work including getHeadSha", async () => {
    kvData.set("srcindex:claim", { claimedAt: 1 });
    const result = await runCodeIndexTick();
    expect(result.status).toBe("claim_lost");
    expect(getHeadShaSpy).not.toHaveBeenCalled();
    // The losing racer must not release the winner's claim.
    expect(kvData.has("srcindex:claim")).toBe(true);
  });

  it("vector not configured → unavailable no-op, zero github calls", async () => {
    isVectorConfiguredMock.mockReturnValue(false);
    const result = await runCodeIndexTick();
    expect(result.status).toBe("not_configured");
    expect(getHeadShaSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("src_index_unavailable", expect.anything());
  });

  it("first run: upserts each eligible file's chunks, writes manifest with blob shas + counts, advances sha, releases claim", async () => {
    getHeadShaSpy.mockResolvedValue("sha-2");
    getRepoTreeSnapshotSpy.mockResolvedValue({
      sha: "sha-2",
      truncated: false,
      blobs: [{ path: "src/a.ts", sha: "blob-a", size: 50 }],
    });
    readFileSpy.mockResolvedValue({ path: "src/a.ts", content: "export const a = 1;\n" });
    const result = await runCodeIndexTick();
    expect(result).toMatchObject({ status: "complete", upserted: 1, deleted: 0, skipped: 0, remaining: 0 });
    // S5: content read pinned to the snapshot sha
    expect(readFileSpy).toHaveBeenCalledWith("src/a.ts", "sha-2");
    expect(vectorUpsertSpy).toHaveBeenCalledWith(
      "acme_backend:src",
      [expect.objectContaining({ id: "src/a.ts#0", metadata: expect.objectContaining({ path: "src/a.ts", startLine: 1 }) })],
    );
    expect(kvData.get("srcindex:manifest")).toEqual({ "src/a.ts": { sha: "blob-a", chunks: 1 } });
    expect(kvData.get("srcindex:sha")).toBe("sha-2");
    expect(kvData.has("srcindex:claim")).toBe(false); // released in finally
  });

  it("incremental: only the changed blob is read + upserted; the unchanged one is untouched", async () => {
    kvData.set("srcindex:sha", "sha-2");
    kvData.set("srcindex:manifest", {
      "src/a.ts": { sha: "blob-a", chunks: 1 },
      "src/b.ts": { sha: "blob-b-old", chunks: 2 },
    });
    getHeadShaSpy.mockResolvedValue("sha-3");
    getRepoTreeSnapshotSpy.mockResolvedValue({
      sha: "sha-3",
      truncated: false,
      blobs: [
        { path: "src/a.ts", sha: "blob-a", size: 50 },
        { path: "src/b.ts", sha: "blob-b-new", size: 50 },
      ],
    });
    readFileSpy.mockResolvedValue({ path: "src/b.ts", content: "export const b = 2;\n" });
    const result = await runCodeIndexTick();
    expect(result).toMatchObject({ status: "complete", upserted: 1 });
    expect(readFileSpy).toHaveBeenCalledTimes(1);
    expect(readFileSpy).toHaveBeenCalledWith("src/b.ts", "sha-3");
    expect((kvData.get("srcindex:manifest") as SrcManifest)["src/b.ts"]).toEqual({ sha: "blob-b-new", chunks: 1 });
    expect(kvData.get("srcindex:sha")).toBe("sha-3");
  });

  it("shrink: trims stale ordinals AFTER the upsert, manifest records the new smaller count", async () => {
    // src/b.ts previously 3 chunks, new content chunks to 1 →
    // vectorDelete(["src/b.ts#1","src/b.ts#2"]) and callOrder shows upsert before delete.
    kvData.set("srcindex:manifest", { "src/b.ts": { sha: "old", chunks: 3 } });
    getHeadShaSpy.mockResolvedValue("sha-shrink");
    getRepoTreeSnapshotSpy.mockResolvedValue({
      sha: "sha-shrink",
      truncated: false,
      blobs: [{ path: "src/b.ts", sha: "blob-b-new", size: 50 }],
    });
    readFileSpy.mockResolvedValue({ path: "src/b.ts", content: "export const b = 2;\n" });
    await runCodeIndexTick();
    expect(vectorDeleteSpy).toHaveBeenCalledWith("acme_backend:src", ["src/b.ts#1", "src/b.ts#2"]);
    expect(callOrder.indexOf("vectorUpsert")).toBeLessThan(callOrder.indexOf("vectorDelete"));
    expect(kvData.get("srcindex:manifest")).toEqual({ "src/b.ts": { sha: "blob-b-new", chunks: 1 } });
  });

  it("deleted file: batched vectorDelete of all its ordinals, manifest entry removed, no readFile", async () => {
    kvData.set("srcindex:manifest", { "src/gone.ts": { sha: "g", chunks: 2 } });
    getHeadShaSpy.mockResolvedValue("sha-4");
    getRepoTreeSnapshotSpy.mockResolvedValue({ sha: "sha-4", truncated: false, blobs: [] });
    const result = await runCodeIndexTick();
    expect(result).toMatchObject({ status: "complete", deleted: 1 });
    expect(vectorDeleteSpy).toHaveBeenCalledWith("acme_backend:src", ["src/gone.ts#0", "src/gone.ts#1"]);
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(kvData.get("srcindex:manifest")).toEqual({});
  });

  it("budget: MAX_FILES_PER_TICK + 1 changed files → exactly MAX processed, remaining 1, sha NOT advanced (S4)", async () => {
    const blobs = Array.from({ length: MAX_FILES_PER_TICK + 1 }, (_, i) =>
      ({ path: `src/f${i}.ts`, sha: `blob-${i}`, size: 10 }));
    getHeadShaSpy.mockResolvedValue("sha-5");
    getRepoTreeSnapshotSpy.mockResolvedValue({ sha: "sha-5", truncated: false, blobs });
    readFileSpy.mockImplementation(async (path: string) => ({
      path,
      content: "export const x = 1;\n",
    }));
    const result = await runCodeIndexTick();
    expect(result).toMatchObject({ status: "partial", upserted: MAX_FILES_PER_TICK, remaining: 1 });
    expect(readFileSpy).toHaveBeenCalledTimes(MAX_FILES_PER_TICK);
    expect(kvData.get("srcindex:sha")).not.toBe("sha-5");
    // …and the completed files ARE in the manifest, so the next tick's diff is exactly the remainder.
    expect(Object.keys(kvData.get("srcindex:manifest") as SrcManifest)).toHaveLength(MAX_FILES_PER_TICK);
  });

  it("wall-clock budget: injected clock advancing 100s per file stops after 2 files despite budget of 40", async () => {
    let t = 0;
    const now = () => { const v = t; t += 100_000; return v; };
    const blobs = Array.from({ length: 5 }, (_, i) =>
      ({ path: `src/f${i}.ts`, sha: `blob-${i}`, size: 10 }));
    getHeadShaSpy.mockResolvedValue("sha-clock");
    getRepoTreeSnapshotSpy.mockResolvedValue({ sha: "sha-clock", truncated: false, blobs });
    readFileSpy.mockImplementation(async (path: string) => ({
      path,
      content: "export const x = 1;\n",
    }));
    const result = await runCodeIndexTick({ now });
    expect(result.upserted).toBe(2); // 0ms, 100s < 180s budget; 200s > budget → stop
    expect(result.status).toBe("partial");
  });

  it("vector degradation mid-tick: upsert false on file 2 → stop, manifest keeps ONLY file 1, sha untouched, no throw", async () => {
    vectorUpsertSpy.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    getHeadShaSpy.mockResolvedValue("sha-deg");
    getRepoTreeSnapshotSpy.mockResolvedValue({
      sha: "sha-deg",
      truncated: false,
      blobs: [
        { path: "src/a.ts", sha: "blob-a", size: 50 },
        { path: "src/b.ts", sha: "blob-b", size: 50 },
      ],
    });
    readFileSpy.mockImplementation(async (path: string) => ({
      path,
      content: "export const x = 1;\n",
    }));
    const result = await runCodeIndexTick();
    expect(result.status).toBe("degraded");
    expect(kvData.get("srcindex:manifest")).toEqual({ "src/a.ts": { sha: "blob-a", chunks: 1 } });
    expect(kvData.get("srcindex:sha")).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith("src_index_degraded", expect.anything());
  });

  it("truncated tree: aborts BEFORE any delete or upsert (the mass-delete guard)", async () => {
    kvData.set("srcindex:manifest", { "src/a.ts": { sha: "a", chunks: 1 } });
    getHeadShaSpy.mockResolvedValue("sha-6");
    getRepoTreeSnapshotSpy.mockResolvedValue({ sha: "sha-6", truncated: true, blobs: [] });
    const result = await runCodeIndexTick();
    expect(result.status).toBe("tree_truncated");
    expect(vectorDeleteSpy).not.toHaveBeenCalled();
    expect(vectorUpsertSpy).not.toHaveBeenCalled();
    expect(kvData.get("srcindex:manifest")).toEqual({ "src/a.ts": { sha: "a", chunks: 1 } });
  });

  it("one unreadable file: skipped + logged, siblings processed, sha NOT advanced so only the failure retries", async () => {
    getHeadShaSpy.mockResolvedValue("sha-7");
    getRepoTreeSnapshotSpy.mockResolvedValue({
      sha: "sha-7",
      truncated: false,
      blobs: [
        { path: "src/a.ts", sha: "blob-a", size: 50 },
        { path: "src/b.ts", sha: "blob-b", size: 50 },
      ],
    });
    readFileSpy.mockImplementation(async (path: string) => {
      if (path === "src/a.ts") throw new Error("github_unreachable");
      return { path, content: "export const b = 2;\n" };
    });
    const result = await runCodeIndexTick();
    // A skipped file is NOT done — it stays out of the manifest and is
    // re-diffed next tick, so it counts toward `remaining` (PR #138).
    expect(result).toMatchObject({ upserted: 1, skipped: 1, remaining: 1 });
    expect(result.status).not.toBe("complete");
    expect(logSpy).toHaveBeenCalledWith("src_index_file_skipped", expect.objectContaining({ path: "src/a.ts" }));
    const manifest = kvData.get("srcindex:manifest") as SrcManifest;
    expect(manifest["src/a.ts"]).toBeUndefined();
    expect(kvData.get("srcindex:sha")).toBeUndefined();
  });

  it("all files unreadable: remaining reports the full backlog, not zero (PR #138 review)", async () => {
    getHeadShaSpy.mockResolvedValue("sha-9");
    getRepoTreeSnapshotSpy.mockResolvedValue({
      sha: "sha-9",
      truncated: false,
      blobs: [
        { path: "src/a.ts", sha: "blob-a", size: 50 },
        { path: "src/b.ts", sha: "blob-b", size: 50 },
      ],
    });
    readFileSpy.mockRejectedValue(new Error("github_unreachable"));
    const result = await runCodeIndexTick();
    expect(result).toMatchObject({ status: "partial", upserted: 0, skipped: 2, remaining: 2 });
    expect(kvData.get("srcindex:sha")).toBeUndefined();
  });

  it("S8 privacy: no log call ever contains file content", async () => {
    const MARKER = "SECRET_CONTENT_MARKER_XYZ";
    getHeadShaSpy.mockResolvedValue("sha-8");
    getRepoTreeSnapshotSpy.mockResolvedValue({
      sha: "sha-8",
      truncated: false,
      blobs: [{ path: "src/a.ts", sha: "blob-a", size: 50 }],
    });
    readFileSpy.mockResolvedValue({ path: "src/a.ts", content: `export const k = "${MARKER}";\n` });
    await runCodeIndexTick();
    for (const call of logSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(MARKER);
    }
  });
});
