// ── Incremental semantic code index (#135) ───────────────────────────
// Keeps a STABLE vector namespace (`{owner}/{repo}:src`, see
// srcNamespace) in sync with the repo's source tree, one cron tick at a
// time. Unlike the docs pipeline (SHA-scoped generations, full rebuild
// per SHA — repo-index.ts), source trees are too large to re-embed per
// commit, so the index advances incrementally:
//
//   manifest (srcindex:manifest) — Record<path, {sha: blobSha, chunks}>
//   is BOTH the index of what's embedded AND the progress cursor: each
//   tick diffs the current tree snapshot against it and processes only
//   the difference, bounded by MAX_FILES_PER_TICK and a wall-clock
//   budget. A partial tick persists its progress in the manifest, so
//   the next tick's diff is exactly the remainder.
//
// Invariants (see the #135 design):
//   S1 single writer — NX claim `srcindex:claim` (TTL 270s > route
//      maxDuration 240s, < the 300s cron cadence, mirroring recovery
//      I4), deleted in finally.
//   S2 vector-leads-manifest — a file enters the manifest only AFTER
//      its chunks were upserted (and stale ordinals trimmed), so the
//      manifest never claims vectors that don't exist.
//   S3 one SHA snapshot per tick — every readFile is pinned to the
//      tree snapshot's sha; no torn reads across a mid-tick push.
//   S4 `srcindex:sha` advances ONLY on a clean complete tick (no
//      remainder, no skips, no degradation) — the noop fast path can
//      never mask unfinished work.
//   S5 truncated-tree abort BEFORE any delete — a partial tree listing
//      must not be interpreted as mass deletion.
//   S6 single eligibility predicate — both diff sides consume
//      isEmbeddableSourcePath.
//   S7 non-throwing degradation — vector failures stop the tick with
//      status "degraded"; they never throw or corrupt the manifest.
//   S8 privacy — file content NEVER reaches logs; paths and counts only.

import { kv } from "./kv";
import { log } from "./logger";
import {
  isVectorConfigured,
  srcNamespace,
  vectorUpsert,
  vectorDelete,
} from "./vector";
import { getCachedConfig } from "./repo-index";
import {
  isEmbeddableSourcePath,
  chunkCodeFile,
} from "./code-chunker";
import type { BattleMageConfig } from "./config";

// ── KV keys ──────────────────────────────────────────────────────────
export const SRC_INDEX_MANIFEST_KEY = "srcindex:manifest";
export const SRC_INDEX_SHA_KEY = "srcindex:sha";
export const SRC_INDEX_CLAIM_KEY = "srcindex:claim";

// ── Budgets & timing ─────────────────────────────────────────────────

/** Max files (re)embedded per tick — bounds the GitHub content fan-out. */
export const MAX_FILES_PER_TICK = 40;

/** Wall-clock budget per tick; checked after each file against the
 * injectable clock so the tick yields before the route's maxDuration. */
export const TICK_TIME_BUDGET_MS = 180_000;

/** Cap on stale-vector ids deleted per tick (mass-rename safety). */
export const MAX_DELETE_IDS_PER_TICK = 1000;

/** The cron route's `export const maxDuration` (mirrored here so the
 * timing-invariant test can pin claim TTL > route budget). */
export const CODE_INDEX_ROUTE_MAX_DURATION_SEC = 240;

/** NX-claim TTL: strictly greater than the route's maxDuration (a live
 * tick can never lose its claim mid-run) and strictly under the 300s
 * cron cadence (an abandoned claim delays work by at most one tick). */
export const SRC_INDEX_CLAIM_TTL_SEC = 270;

// ── Types ────────────────────────────────────────────────────────────

/** What's embedded, per path: the blob sha it was chunked from and how
 * many ordinal chunks exist in the vector namespace. */
export type SrcManifest = Record<string, { sha: string; chunks: number }>;

export interface TreeBlob {
  path: string;
  sha: string;
  size?: number;
}

export interface SrcIndexDiff {
  /** Eligible blobs that are new or whose blob sha changed. */
  toUpsert: TreeBlob[];
  /** Manifest entries whose path vanished from the tree OR became
   * ineligible — their chunks must be deleted. */
  toDelete: { path: string; chunks: number }[];
}

export type CodeIndexTickStatus =
  | "not_configured"
  | "claim_lost"
  | "noop"
  | "tree_truncated"
  | "complete"
  | "partial"
  | "degraded";

export interface CodeIndexTickResult {
  status: CodeIndexTickStatus;
  /** Files whose chunks were (re)embedded this tick. */
  upserted: number;
  /** Files whose chunks were removed this tick. */
  deleted: number;
  /** Files that failed to read and were skipped (retried next tick). */
  skipped: number;
  /** Diff entries left for the next tick. */
  remaining: number;
}

// ── Pure helpers ─────────────────────────────────────────────────────

/** All ordinal chunk ids for a path: `${path}#0` .. `${path}#count-1`. */
export function chunkIdsFor(path: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${path}#${i}`);
}

/**
 * Ids left dangling when a file shrinks from oldCount to newCount
 * chunks. Growth and equality trim nothing. Trimmed AFTER the upsert
 * (D2): between upsert and trim the worst case is a few stale-but-
 * harmless extra chunks, never missing ones.
 */
export function staleChunkIds(path: string, oldCount: number, newCount: number): string[] {
  if (newCount >= oldCount) return [];
  return Array.from({ length: oldCount - newCount }, (_, i) => `${path}#${newCount + i}`);
}

/**
 * Diff a full tree snapshot against the manifest (S6: BOTH sides use
 * isEmbeddableSourcePath). Pure function.
 *
 * - eligible blob absent from manifest, or present with a different
 *   blob sha → toUpsert
 * - manifest path missing from the tree, or present but no longer
 *   eligible (deleted file, new config annotation, size growth) →
 *   toDelete with its recorded chunk count
 */
export function diffTreeAgainstManifest(
  blobs: TreeBlob[],
  manifest: SrcManifest,
  config: BattleMageConfig,
): SrcIndexDiff {
  const eligible = new Map<string, TreeBlob>();
  for (const blob of blobs) {
    if (isEmbeddableSourcePath(blob.path, blob.size, config)) {
      eligible.set(blob.path, blob);
    }
  }

  const toUpsert: TreeBlob[] = [];
  for (const blob of eligible.values()) {
    const entry = manifest[blob.path];
    if (!entry || entry.sha !== blob.sha) toUpsert.push(blob);
  }

  const toDelete: { path: string; chunks: number }[] = [];
  for (const [path, entry] of Object.entries(manifest)) {
    if (!eligible.has(path)) toDelete.push({ path, chunks: entry.chunks });
  }

  return { toUpsert, toDelete };
}

// ── The tick ─────────────────────────────────────────────────────────

export interface CodeIndexTickOptions {
  /** Injectable clock for the wall-clock budget (tests). */
  now?: () => number;
}

function emptyResult(status: CodeIndexTickStatus): CodeIndexTickResult {
  return { status, upserted: 0, deleted: 0, skipped: 0, remaining: 0 };
}

/**
 * One incremental indexing tick. Non-throwing for every EXPECTED
 * failure mode (vector degradation, unreadable files, truncated tree);
 * infrastructure errors (KV down) propagate to the route's catch.
 */
export async function runCodeIndexTick(
  options?: CodeIndexTickOptions,
): Promise<CodeIndexTickResult> {
  const now = options?.now ?? Date.now;

  if (!isVectorConfigured()) {
    // Expected state for installs without UPSTASH_VECTOR_* — not an error.
    log("src_index_unavailable", { reason: "not_configured" });
    return emptyResult("not_configured");
  }

  // S1: single writer. SET NX → null means another tick holds the claim
  // (Upstash semantics, same protocol as acquireSweepClaim). The loser
  // does NO work at all — not even the head-SHA read.
  const claimed = await kv.set(
    SRC_INDEX_CLAIM_KEY,
    { claimedAt: Date.now() },
    { nx: true, ex: SRC_INDEX_CLAIM_TTL_SEC },
  );
  if (claimed === null) {
    log("src_index_claim_lost", {});
    return emptyResult("claim_lost");
  }

  try {
    const { getHeadSha, getRepoTreeSnapshot, readFile } = await import("@/lib/github");

    // Fast path: nothing moved since the last CLEAN tick (S4).
    const headSha = await getHeadSha();
    const indexedSha = await kv.get<string>(SRC_INDEX_SHA_KEY);
    if (headSha === indexedSha) {
      log("src_index_noop", { sha: headSha });
      return emptyResult("noop");
    }

    // S3: one snapshot per tick — every content read below is pinned to
    // snapshot.sha, never to a moving branch head.
    const snapshot = await getRepoTreeSnapshot(headSha);
    if (snapshot.truncated) {
      // S5: a truncated listing looks like mass deletion — abort before
      // ANY delete or upsert.
      log("src_index_tree_truncated", { sha: snapshot.sha });
      return emptyResult("tree_truncated");
    }

    const config = await getCachedConfig();
    const manifest = (await kv.get<SrcManifest>(SRC_INDEX_MANIFEST_KEY)) ?? {};
    const diff = diffTreeAgainstManifest(snapshot.blobs, manifest, config);

    // Working copy — mutated as files complete, written ONCE at tick end
    // (also on degraded exit) so partial progress always persists.
    const working: SrcManifest = { ...manifest };
    const namespace = srcNamespace();
    let upserted = 0;
    let deleted = 0;
    let skipped = 0;
    let degraded = false;

    const finish = async (): Promise<CodeIndexTickResult> => {
      const remaining =
        diff.toUpsert.length + diff.toDelete.length - upserted - skipped - deleted;
      await kv.set(SRC_INDEX_MANIFEST_KEY, working);
      const clean = !degraded && remaining === 0 && skipped === 0;
      if (clean) await kv.set(SRC_INDEX_SHA_KEY, snapshot.sha);
      const status: CodeIndexTickStatus = degraded
        ? "degraded"
        : clean
        ? "complete"
        : "partial";
      const result: CodeIndexTickResult = { status, upserted, deleted, skipped, remaining };
      log("src_index_tick", { sha: snapshot.sha, ...result });
      return result;
    };

    // ── Deletions first: one batched vectorDelete, capped per tick ──
    if (diff.toDelete.length > 0) {
      const deleteIds: string[] = [];
      const deletablePaths: string[] = [];
      for (const entry of diff.toDelete) {
        const ids = chunkIdsFor(entry.path, entry.chunks);
        if (deleteIds.length + ids.length > MAX_DELETE_IDS_PER_TICK) break;
        deleteIds.push(...ids);
        deletablePaths.push(entry.path);
      }
      if (deleteIds.length > 0) {
        const ok = await vectorDelete(namespace, deleteIds);
        if (!ok) {
          degraded = true;
          log("src_index_degraded", { phase: "delete", ids: deleteIds.length });
          return await finish();
        }
        // S2 for deletes: manifest entries drop only AFTER the vectors did.
        for (const path of deletablePaths) delete working[path];
        deleted += deletablePaths.length;
      }
    }

    // ── Upserts: bounded by file count AND wall clock ────────────────
    const startedAt = now();
    for (const blob of diff.toUpsert) {
      if (upserted + skipped >= MAX_FILES_PER_TICK) break;

      let content: string | null = null;
      try {
        const result = await readFile(blob.path, snapshot.sha);
        if ("content" in result && typeof result.content === "string") {
          content = result.content;
        }
      } catch (err) {
        // One unreadable file must not sink the tick — skip it (the
        // un-advanced sha + missing manifest entry retry it next tick).
        skipped++;
        log("src_index_file_skipped", {
          path: blob.path,
          errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err),
        });
        if (now() - startedAt > TICK_TIME_BUDGET_MS) break;
        continue;
      }

      if (content === null) {
        skipped++;
        log("src_index_file_skipped", { path: blob.path, reason: "not_a_file" });
        if (now() - startedAt > TICK_TIME_BUDGET_MS) break;
        continue;
      }

      const chunks = chunkCodeFile(blob.path, content);
      const previousChunks = working[blob.path]?.chunks ?? 0;

      if (chunks.length > 0) {
        const ok = await vectorUpsert(
          namespace,
          chunks.map((c) => ({ id: c.id, text: c.text, metadata: c.metadata })),
        );
        if (!ok) {
          degraded = true;
          log("src_index_degraded", { phase: "upsert", path: blob.path });
          return await finish();
        }
      }

      // D2: shrink-trim AFTER the upsert — the window between them can
      // only over-serve (stale ordinals), never under-serve.
      const stale = staleChunkIds(blob.path, previousChunks, chunks.length);
      if (stale.length > 0) {
        const ok = await vectorDelete(namespace, stale);
        if (!ok) {
          // Trim failed: do NOT record the new manifest entry — the old
          // entry (old sha + old count) makes the next tick redo both
          // the upsert (idempotent) and the trim.
          degraded = true;
          log("src_index_degraded", { phase: "trim", path: blob.path });
          return await finish();
        }
      }

      // S2: manifest reflects the file only after its vectors settled.
      working[blob.path] = { sha: blob.sha, chunks: chunks.length };
      upserted++;

      if (now() - startedAt > TICK_TIME_BUDGET_MS) break;
    }

    return await finish();
  } finally {
    // Release the claim on every exit path past acquisition. A crash
    // that skips this leaves the TTL to expire — one missed cadence.
    await kv.del(SRC_INDEX_CLAIM_KEY);
  }
}
