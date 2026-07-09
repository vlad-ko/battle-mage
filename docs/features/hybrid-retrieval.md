# Hybrid Retrieval

Hybrid lexical + semantic retrieval (#127) gives the bot two things:

1. **`search_repo` tool** — a hybrid search across code AND docs. A lexical GitHub code-search arm is fused with a semantic (meaning-based) doc-chunk arm, so conceptual questions ("how does message splitting work?") find the right material even when no keyword matches.
2. **Per-turn KB recall** — instead of dumping the entire knowledge base into every system prompt, only the top entries relevant to the *current question* are loaded (top matches, not the full KB), keeping the prompt bounded as the KB grows.

Both are powered by [Upstash Vector](https://upstash.com/docs/vector) with a **built-in embedding model** — the app sends raw text, the index embeds server-side. No embedding API calls from our code.

## Embedding Pipeline

### KB entries (write path: `src/lib/knowledge.ts`)

- `saveKnowledgeEntry` embeds each new entry into the **KB namespace** — `{owner}/{repo}:kb` — keyed by the entry's id, with the timestamp as metadata. The upsert is **best-effort**: KV remains the source of truth, and a vector failure never fails the save.
- Retire flows (`supersedeKnowledgeEntry`, `markKnowledgeSuperseded`, `archiveKnowledgeEntry`) best-effort delete the retired entry's vector. Legacy id-less entries were never embedded, so they are skipped.

### Doc chunks (write path: `src/lib/repo-index.ts`)

Doc embedding runs **only inside the SHA-changed branch** of `getOrRebuildIndex()`, after the topic-index KV writes, and is **fire-and-forget**: the rebuild returns its summary immediately and the embed (content fetches + upsert) completes in the background within the invocation window, so it never delays the agent's turn. Tradeoff: a container killed mid-embed leaves the docs pointer on the previous SHA's namespace until the next SHA change — the doc arm serves slightly stale chunks, never a half-written namespace.

1. `chunkMarkdownByHeadings(path, content)` splits each `docs/**/*.md` on `#`/`##`/`###` headings (`####` stays inside its parent section). Preamble content before the first heading becomes a chunk titled from the path. Sections over `MAX_CHUNK_CHARS` (1500) are re-split on paragraph boundaries. Ids are deterministic `${path}#${ordinal}`; metadata carries `{path, heading, excerpt}`.
2. Content fetches are capped at `MAX_DOCS_TO_EMBED` (50) per rebuild — the same GitHub fan-out lesson as #108. Exceeding the cap logs `docs_embed_capped`.
3. Chunks are upserted into a **SHA-scoped namespace** — `{owner}/{repo}:docs:{sha}`.

## Namespace / Pointer Lifecycle (docs)

The KV key `index:vector_docs_ns` points at the docs namespace currently serving queries. The generation swap is ordered so readers never see a half-populated namespace:

```
upsert chunks into {owner}/{repo}:docs:{newSha}     (1)
  └─ on success → set index:vector_docs_ns pointer  (2)
       └─ best-effort deleteNamespace(previous)      (3)
```

If the upsert fails, the pointer is untouched — queries keep serving the previous generation — and `docs_embed_failed` records the gap. Likewise, an **empty chunk set** (every doc read failed, or all docs were empty) aborts before any pointer/namespace mutation with `docs_embed_empty` — the pointer must never swap to an empty namespace. The index rebuild itself always succeeds; embedding is never a hard dependency.

## Retrieval and Fusion (`src/lib/retrieval.ts`)

Both retrieval surfaces fuse two ranked arms with **Reciprocal Rank Fusion**: each arm contributes `1/(RRF_K + rank)` per candidate (`RRF_K = 60`, ranks 1-based, within-arm duplicates keep their best rank), so items ranked well in both arms win without the arms' raw scores needing to be comparable.

| Constant | Value | Meaning |
|----------|-------|---------|
| `RRF_K` | 60 | RRF dampening constant |
| `RECALL_TOP_K` | 5 | KB entries surfaced into the prompt per turn |
| `MAX_ARM_RESULTS` | 10 | Cap per arm before fusion |
| `AGE_TIER_BOOSTS` | 7d: +0.00015, 30d: +0.0001, 90d: +0.00005 | Freshness tie-breaker (KB recall only) |

The age boost is deliberately smaller than the smallest adjacent-rank RRF gap a single arm can produce, so freshness only ever breaks ties between effectively-equal candidates — it never overrides relevance. Exact ties keep enumeration order: lexical-arm candidates first.

### KB recall (`getKnowledgeRecallAsMarkdown(question)`)

Recall keys off the user's **clean question**: the turn runner passes it as `recallQuestion` in `RunAgentOptions`, because the `userMessage` the model receives is augmented with topic/effort hints that would pollute both the lexical tokens and the embedding query.

- 0 visible entries → section omitted (null).
- ≤ `RECALL_TOP_K` entries → render all; **no vector call** (the full KB already fits).
- Otherwise: lexical arm = `lexicalRank` (distinct question tokens substring-matching entry text, ties to newer timestamps) + semantic arm = `vectorQuery` on the KB namespace; fuse with timestamps, cap at 5, no padding when fewer match.
- **K1 invariant**: vector ids are mapped back through the visible entry set fetched in the same call — retired (superseded/archived) or unknown ids can never resurface through a stale embedding.
- Both arms empty → fall back to the newest `RECALL_TOP_K` entries.

### `search_repo` (`src/tools/search-repo.ts`)

- Lexical arm: existing `searchCode` with tooling paths filtered, ids `code:${path}`.
- Semantic arm: `index:vector_docs_ns` pointer → `vectorQuery`, ids `doc:${chunkId}`.
- Both arms run in parallel; fusion is untimestamped (repo freshness is per-SHA, not per-result).
- Results render as typed lines — `[code]` with path/score/URL, `[doc]` with path, heading, and excerpt — and produce **no references** (search results are discovery aids).

## The Vector Wrapper (`src/lib/vector.ts`)

All Upstash Vector access flows through one chokepoint mirroring `kv.ts` (#117), with a **non-throwing public API**: `vectorUpsert`/`vectorDelete`/`vectorDeleteNamespace` return booleans, `vectorQuery` returns `VectorMatch[] | null` (`null` = degraded, `[]` = available but no matches). Every op is raced against `VECTOR_OP_TIMEOUT_MS` (2s) so recall can never stall a turn. The SDK client is constructed lazily and only when configured. Query and entry text are **never logged**.

## Degradation Matrix

| Condition | Signal | What degrades |
|-----------|--------|---------------|
| `UPSTASH_VECTOR_REST_*` unset | `vector_unavailable` (op, reason: `not_configured`) — expected state, no Sentry | KB recall runs lexical-only; `search_repo` doc arm empty; doc embedding skipped entirely (no GitHub content fan-out) |
| Vector op error or >2s timeout | `vector_error` (op, namespace, durationMs, errorClass, errorMessage) + Sentry tagged `vector.op` | Same as above for that one call; saves/rebuilds still succeed |
| Docs never embedded (no pointer) | none — `getDocsVectorNamespace()` returns null | `search_repo` lexical-only; vector store never queried |
| Doc upsert failure during rebuild | `docs_embed_failed` | Pointer untouched — previous generation keeps serving; rebuild succeeds |
| Rebuild produces zero chunks | `docs_embed_empty` | Pointer/namespace untouched — previous generation keeps serving |
| > 50 docs in repo | `docs_embed_capped` | Only the first 50 docs are embedded |

The bot always keeps working lexically — the vector layer is an accelerator, never a dependency.

## Event Names

- `vector_op` — `{op, namespace, durationMs, count}` per successful op
- `vector_unavailable` — `{op, reason: "not_configured"}` (NOT an error)
- `vector_error` — `{op, namespace, durationMs, errorClass, errorMessage}` + Sentry tag `vector.op`
- `docs_embedded` — `{sha, docCount, chunkCount, duration_ms}`
- `docs_embed_capped` — `{totalDocs, cap}`
- `docs_embed_empty` — `{sha, docCount}` (zero chunks — pointer untouched)
- `docs_embed_failed` — `{sha, ...}`

See [Observability](../observability.md) for the full catalog.

## Relationship to the Topic Index

The [repo index](./repo-index.md) and the docs vector index are complementary and share the same rebuild trigger (HEAD SHA change):

- The **topic index** is a path-classified map rendered into the system prompt — it tells the model *where areas of the repo live* before any tool call.
- The **docs vector index** is a queryable store of doc *content* chunks — it answers `search_repo` calls at tool time.

## Provisioning

Create an Upstash Vector index **with a built-in embedding model** (raw-text upsert/query via the `data` field) and set `UPSTASH_VECTOR_REST_URL` / `UPSTASH_VECTOR_REST_TOKEN`. See [Setup](../setup.md). Without them, everything above degrades gracefully.
