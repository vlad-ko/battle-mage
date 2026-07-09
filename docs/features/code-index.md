# Incremental Semantic Code Index

The code index (#135, sub-issue of epic #128) extends hybrid retrieval beyond docs: **source files** are chunked and embedded into Upstash Vector, so `search_repo` can answer "where is X handled?" from the code's *meaning*, not just keyword hits. Unlike the docs pipeline (small, rebuilt per SHA — see [hybrid-retrieval.md](hybrid-retrieval.md)), a source tree is far too large to re-embed per commit, so the index advances **incrementally** on a dedicated cron tick.

## Architecture

```
/api/cron/code-index (every 5 min, maxDuration 240s)
  └─ runCodeIndexTick()                      src/lib/code-index.ts
       ├─ NX claim  srcindex:claim (TTL 270s)          — single writer
       ├─ fast path srcindex:sha === head SHA          — noop
       ├─ getRepoTreeSnapshot(headSha)                 — ONE snapshot per tick
       ├─ diff blobs vs srcindex:manifest              — what changed
       ├─ vectorDelete (removed files, batched)        ┐ into the STABLE
       ├─ readFile@snapshot → chunkCodeFile → upsert   ┘ namespace {owner}/{repo}:src
       └─ write manifest once; advance sha only when CLEAN
```

### The manifest is the cursor

`srcindex:manifest` (KV) maps `path → {sha: blobSha, chunks: count}` — it is simultaneously the record of what's embedded and the progress cursor. Each tick diffs the current tree snapshot against it:

- eligible blob new or blob-sha changed → **upsert** (re-chunk + re-embed)
- manifest path gone from the tree, or no longer eligible → **delete** its chunk ids

A partial tick persists completed files in the manifest, so the next tick's diff is exactly the remainder. `srcindex:sha` advances **only on a clean complete tick** (no remainder, no skips, no degradation) — the noop fast path can never mask unfinished work.

### Stable namespace, path-stable ids

The namespace `{owner}/{repo}:src` is deliberately **not** SHA-scoped (contrast `docsNamespace`): ids are `${path}#${ordinal}`, so re-embedding a changed file is an idempotent per-id upsert. When a file shrinks from N to M chunks, the stale ordinals `#M..#N-1` are trimmed **after** the upsert (`staleChunkIds`) — the worst mid-window state is a few stale-but-harmless extra chunks, never missing ones.

## Chunking (`src/lib/code-chunker.ts`, pure)

- **Eligibility** is a single predicate, `isEmbeddableSourcePath`, consumed by BOTH diff sides: extension allowlist (no md/json/yaml/lock — the docs arm owns prose), no tooling paths (`.claude/`), no `.min.` artifacts, no `excluded`/`vendor`/`historic` config annotations, and blobs over `MAX_EMBED_FILE_BYTES` (200 KB) are skipped.
- **TS/JS** files split at **column-0 declaration boundaries** (`export`/`function`/`class`/`const`/…) — a cheap proxy for top-level structure; indented declarations are nested and never split.
- **Everything else** uses a greedy line-window pack; a single oversized line is hard-sliced.
- Every chunk's text is `${path}\n\n${lines}`, hard-capped at `MAX_CODE_CHUNK_CHARS` (1500) including the header. Metadata carries `{path, startLine, endLine, excerpt}` (excerpt ≤160 chars, whitespace-collapsed).

## Tick budgets & safety invariants

| Guard | Value | Why |
|-------|-------|-----|
| `MAX_FILES_PER_TICK` | 40 | Bounds the GitHub content fan-out per tick |
| `TICK_TIME_BUDGET_MS` | 180 000 | Wall-clock yield well inside the route's 240 s `maxDuration` |
| `MAX_DELETE_IDS_PER_TICK` | 1000 | Mass-rename safety |
| `SRC_INDEX_CLAIM_TTL_SEC` | 270 | > route `maxDuration` (a live tick never loses its claim) and < the 300 s cadence |

- **One SHA snapshot per tick** — every `readFile` is pinned to the snapshot's SHA; a push mid-tick can't produce torn reads.
- **Truncated-tree abort** — if GitHub truncates the recursive listing, the tick aborts *before any delete*: a partial tree must not be read as mass deletion.
- **Non-throwing degradation** — a failed vector op stops the tick with status `degraded`; progress so far persists in the manifest, `srcindex:sha` stays put, nothing throws. An unreadable file is skipped and logged; siblings continue.
- **Privacy** — file content never reaches logs (paths + counts only), matching the vector wrapper's rule.

## Retrieval (`search_repo` src arm)

`search_repo` now runs three arms: lexical GitHub code search, semantic doc chunks, and semantic src chunks. The two semantic sub-arms share one embedding model, so their raw scores are comparable — `mergeSemanticMatches` (in `src/lib/retrieval.ts`) merges them by descending score (docs win exact ties) before the merged list enters the existing two-arm RRF fusion against the lexical arm. Typed ids (`code:`/`doc:`/`src:`) keep everything disjoint; the same path can legitimately appear as both a `[code]` and a `[src]` line:

```
- [src] `src/lib/auth.ts:L40-71` — verifies the session token
```

Degradation is per-sub-arm: a degraded src query collapses to docs-only, both degraded collapses to lexical-only, and the tool never throws because of the semantic arm.

## Operations

- Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; the route reuses `isAuthorizedCronRequest` (fail closed — unset secret denies everything).
- Unprovisioned vector env (`UPSTASH_VECTOR_REST_*` unset) is an expected no-op (`src_index_unavailable`), not an error.
- Event vocabulary and health queries: [docs/observability.md](../observability.md) (`src_index_*` section) and [TELEMETRY.md](../../TELEMETRY.md).
