// ── Vector store wrapper with Sentry observability ───────────────────
// Single chokepoint for every Upstash Vector operation, mirroring the
// kv.ts pattern (#117): every call emits a structured `vector_op` log
// line with latency + outcome metadata, and every error emits
// `vector_error` + Sentry.captureException tagged `vector.op`.
//
// Two deliberate differences from kv.ts:
// 1. NON-THROWING public API — the vector index is an optional recall
//    accelerator, never a source of truth. Callers get a boolean/null
//    degradation signal instead of an exception, so a missing or flaky
//    index can never break a save, a rebuild, or an agent turn.
// 2. Graceful "not configured" path — when the UPSTASH_VECTOR_REST_*
//    env vars are absent the wrapper logs `vector_unavailable` (an
//    expected state, NOT an error — no Sentry) and degrades. The SDK
//    client is constructed lazily and only when configured.
//
// The @upstash/vector SDK is confined to createUpstashVectorStore() —
// everything else talks to the VectorStore interface, which is also the
// test seam (__setVectorStoreFactoryForTests injects a fake store).
//
// PRIVACY: query text and entry text are NEVER logged — only namespaces,
// counts, and durations. See #127.

import { Index } from "@upstash/vector";
import * as Sentry from "@sentry/nextjs";
import { log } from "./logger";

// ── Types ────────────────────────────────────────────────────────────

export interface VectorUpsertItem {
  id: string;
  /** Raw text — the index embeds it server-side (built-in model). */
  text: string;
  metadata?: Record<string, unknown>;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/**
 * The narrow store contract the rest of the codebase depends on. The
 * only production implementation wraps @upstash/vector; tests inject
 * fakes through __setVectorStoreFactoryForTests.
 */
export interface VectorStore {
  upsert(namespace: string, items: VectorUpsertItem[]): Promise<void>;
  query(namespace: string, text: string, topK: number): Promise<VectorMatch[]>;
  delete(namespace: string, ids: string[]): Promise<void>;
  deleteNamespace(namespace: string): Promise<void>;
}

// ── Configuration & namespaces ───────────────────────────────────────

/**
 * True when both Upstash Vector env vars are present. Checked per call
 * (not at module load) so tests and late-injected env both work.
 */
export function isVectorConfigured(): boolean {
  // GitHub identity is part of "configured": namespaces are derived from
  // GITHUB_OWNER/GITHUB_REPO, and running vector ops without them would
  // silently read/write a shared "undefined_undefined:*" namespace. A
  // missing identity degrades exactly like missing Upstash creds.
  return Boolean(
    process.env.UPSTASH_VECTOR_REST_URL &&
      process.env.UPSTASH_VECTOR_REST_TOKEN &&
      process.env.GITHUB_OWNER &&
      process.env.GITHUB_REPO,
  );
}

/**
 * Owner/repo prefix shared by every namespace. Joined with `_`, NOT `/`:
 * the Upstash Vector REST client inserts the namespace into the URL path
 * verbatim, so a slash splits the route and every operation 404s
 * ("Endpoint POST /upsert-data/<owner> not found" — Sentry BATTLE-MAGE-4).
 * GitHub owner/repo names can't contain `_`-vs-`/` ambiguity collisions
 * in practice for a single-target bot, and nothing was ever successfully
 * written under the slashed namespaces, so no migration is needed.
 */
function namespacePrefix(): string {
  return `${process.env.GITHUB_OWNER}_${process.env.GITHUB_REPO}`;
}

/** Namespace holding one embedding per visible KB entry. */
export function kbNamespace(): string {
  return `${namespacePrefix()}:kb`;
}

/**
 * Namespace holding doc chunks for one repo SHA. SHA-scoped so a rebuild
 * writes a fresh namespace and atomically repoints (see repo-index.ts).
 */
export function docsNamespace(sha: string): string {
  return `${namespacePrefix()}:docs:${sha}`;
}

/**
 * Namespace holding source-code chunks (#135). Deliberately STABLE
 * (not SHA-scoped, unlike docsNamespace): the code index is maintained
 * incrementally — per-file diffs against a KV manifest — so ids must
 * survive across ticks instead of being rebuilt per generation.
 */
export function srcNamespace(): string {
  return `${namespacePrefix()}:src`;
}

// ── Store construction (lazy + memoized; SDK confined here) ──────────

type VectorStoreFactory = () => VectorStore;

/**
 * The ONLY code that touches @upstash/vector. Verified against SDK
 * v1.2.3: `new Index({url, token})`, `index.namespace(ns)` for scoped
 * upsert/query/delete, raw-text ingestion via the `data` field (the
 * index embeds server-side), `index.deleteNamespace(ns)`.
 */
function createUpstashVectorStore(): VectorStore {
  const index = new Index({
    url: process.env.UPSTASH_VECTOR_REST_URL,
    token: process.env.UPSTASH_VECTOR_REST_TOKEN,
  });
  return {
    async upsert(namespace, items) {
      await index.namespace(namespace).upsert(
        items.map((i) => ({ id: i.id, data: i.text, metadata: i.metadata })),
      );
    },
    async query(namespace, text, topK) {
      const results = await index
        .namespace(namespace)
        .query({ data: text, topK, includeMetadata: true });
      return results.map((r) => ({
        id: String(r.id),
        score: r.score,
        metadata: r.metadata as Record<string, unknown> | undefined,
      }));
    },
    async delete(namespace, ids) {
      await index.namespace(namespace).delete(ids);
    },
    async deleteNamespace(namespace) {
      await index.deleteNamespace(namespace);
    },
  };
}

let storeFactory: VectorStoreFactory = createUpstashVectorStore;
let memoizedStore: VectorStore | null = null;

/**
 * Test seam: inject a fake store factory (null restores the real one).
 * Also resets the memoized store so each test constructs afresh.
 */
export function __setVectorStoreFactoryForTests(factory: VectorStoreFactory | null): void {
  storeFactory = factory ?? createUpstashVectorStore;
  memoizedStore = null;
}

// Lazily construct + memoize. NEVER called on the unconfigured path —
// the public API short-circuits first, so the factory (and therefore
// the SDK client) is only ever invoked when env credentials exist.
function getStore(): VectorStore {
  if (!memoizedStore) memoizedStore = storeFactory();
  return memoizedStore;
}

// ── Timeout guard ────────────────────────────────────────────────────

/** Hard latency cap per vector op — recall must never stall a turn. */
export const VECTOR_OP_TIMEOUT_MS = 2000;

/**
 * Timeout for background embed pipelines (code index, doc embedding),
 * where a single upsert batch is server-side-embedded and legitimately
 * needs seconds — the 2s interactive cap starved them and stalled the
 * index on large files (BATTLE-MAGE-5). Cron budgets absorb the slack.
 */
export const VECTOR_BACKGROUND_TIMEOUT_MS = 30_000;

/**
 * Max items per underlying store call. One upsert request carrying a
 * whole large file (or a whole docs corpus) embeds slowly and fails as
 * a unit; smaller batches keep per-request latency inside the timeout
 * and make retries finer-grained. Ids are deterministic, so re-sending
 * a batch after a mid-list failure is harmless.
 */
export const UPSERT_BATCH_SIZE = 20;

export class VectorTimeoutError extends Error {
  constructor(op: string, timeoutMs: number) {
    super(`vector ${op} exceeded ${timeoutMs}ms`);
    this.name = "VectorTimeoutError";
  }
}

function withTimeout<T>(
  op: string,
  promise: Promise<T>,
  timeoutMs: number = VECTOR_OP_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new VectorTimeoutError(op, timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// ── Shared logging helpers (mirror kv.ts) ────────────────────────────

type VectorOp = "upsert" | "query" | "delete" | "deleteNamespace";

function logUnavailable(op: VectorOp): void {
  // Expected degradation state, not an error — no Sentry capture.
  log("vector_unavailable", { op, reason: "not_configured" });
}

function logError(op: VectorOp, namespace: string, startedAt: number, err: unknown): void {
  const errorMessage = err instanceof Error ? err.message : String(err);
  const errorClass = err instanceof Error ? err.constructor.name : "Unknown";
  log("vector_error", {
    op,
    namespace,
    durationMs: Date.now() - startedAt,
    errorClass,
    errorMessage: errorMessage.slice(0, 200),
  });
  Sentry.captureException(err, {
    tags: { "vector.op": op, "vector.namespace": namespace },
  });
}

// ── Public wrapper (non-throwing) ────────────────────────────────────

/**
 * Embed + store items. Returns true on success, false on degradation
 * (not configured, timeout, or store error). An empty item list
 * short-circuits true without touching the store.
 */
export async function vectorUpsert(
  namespace: string,
  items: VectorUpsertItem[],
  opts?: { timeoutMs?: number },
): Promise<boolean> {
  if (items.length === 0) return true;
  if (!isVectorConfigured()) {
    logUnavailable("upsert");
    return false;
  }
  const timeoutMs = opts?.timeoutMs ?? VECTOR_OP_TIMEOUT_MS;
  const startedAt = Date.now();
  try {
    // Sequential batches; stop on the first failure. Completed batches
    // stay written — deterministic ids make the caller's retry re-send
    // them idempotently.
    for (let i = 0; i < items.length; i += UPSERT_BATCH_SIZE) {
      const batch = items.slice(i, i + UPSERT_BATCH_SIZE);
      await withTimeout("upsert", getStore().upsert(namespace, batch), timeoutMs);
    }
    log("vector_op", {
      op: "upsert",
      namespace,
      durationMs: Date.now() - startedAt,
      count: items.length,
      batches: Math.ceil(items.length / UPSERT_BATCH_SIZE),
    });
    return true;
  } catch (err) {
    logError("upsert", namespace, startedAt, err);
    return false;
  }
}

/**
 * Semantic similarity query. Returns matches on success, [] when the
 * index is available but has no matches, and null when the vector layer
 * is degraded (not configured, timeout, or store error) — callers use
 * null to fall back to lexical-only retrieval.
 */
export async function vectorQuery(
  namespace: string,
  text: string,
  topK: number,
): Promise<VectorMatch[] | null> {
  if (!isVectorConfigured()) {
    logUnavailable("query");
    return null;
  }
  const startedAt = Date.now();
  try {
    const matches = await withTimeout("query", getStore().query(namespace, text, topK));
    log("vector_op", {
      op: "query",
      namespace,
      durationMs: Date.now() - startedAt,
      count: matches.length,
    });
    return matches;
  } catch (err) {
    logError("query", namespace, startedAt, err);
    return null;
  }
}

/** Delete ids from a namespace. Returns false on any degradation. */
export async function vectorDelete(namespace: string, ids: string[]): Promise<boolean> {
  if (!isVectorConfigured()) {
    logUnavailable("delete");
    return false;
  }
  const startedAt = Date.now();
  try {
    await withTimeout("delete", getStore().delete(namespace, ids));
    log("vector_op", {
      op: "delete",
      namespace,
      durationMs: Date.now() - startedAt,
      count: ids.length,
    });
    return true;
  } catch (err) {
    logError("delete", namespace, startedAt, err);
    return false;
  }
}

/** Drop an entire namespace (stale docs generation). Non-throwing. */
export async function vectorDeleteNamespace(namespace: string): Promise<boolean> {
  if (!isVectorConfigured()) {
    logUnavailable("deleteNamespace");
    return false;
  }
  const startedAt = Date.now();
  try {
    await withTimeout("deleteNamespace", getStore().deleteNamespace(namespace));
    log("vector_op", {
      op: "deleteNamespace",
      namespace,
      durationMs: Date.now() - startedAt,
    });
    return true;
  } catch (err) {
    logError("deleteNamespace", namespace, startedAt, err);
    return false;
  }
}
