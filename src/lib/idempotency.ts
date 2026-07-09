// ── Idempotent execution for GitHub issue creation (#125) ────────────
// Slack delivers webhook events at-least-once, and two humans can
// confirm the same proposal in the same second. The del-claim protocol
// in route.ts already serializes *batch* claims, but the innermost
// createIssue call had no memory: any path that re-reached it created
// a duplicate GitHub issue. This module gives every issue-creating call
// a durable, content-addressed memory in KV.
//
// Protocol (executeIdempotent):
//   1. GET key — completed record?  → replay the recorded result.
//   2. SET pending {nx, ex: 60s}    → atomic lock acquisition.
//      NX lost? RE-GET: completed   → replay (competitor finished in
//      the TOCTOU window between our GET and SET); still pending →
//      in_flight (competitor is running right now — do NOT create).
//   3. Run fn. On throw: DEL the lock and rethrow — the operation is
//      retryable, nothing was created.
//   4. SET completed {result, ex: 30d} so any later duplicate replays.
//
// Failure posture: FAIL OPEN. If KV is unreachable we run fn anyway
// and log `idempotency_degraded` — a rare duplicate issue beats a
// broken confirmation flow. A completed-record write failure after fn
// succeeded must NEVER throw (the issue exists; surfacing an error
// would be a lie), so it degrades the same way.
//
// Events: idempotency_replayed, idempotency_in_flight,
// idempotency_degraded. See TELEMETRY.md.

import { createHash } from "node:crypto";
import { kv } from "./kv";
import { log, type LogFn } from "./logger";

/** Pending-lock TTL. Longer than any plausible createIssue call, short
 * enough that a crashed holder doesn't block a legitimate retry. */
export const LOCK_TTL_SEC = 60;

/** Completed-record TTL: 30 days. Covers any realistic re-confirmation
 * window (stale Slack threads, re-delivered events). */
export const COMPLETED_TTL_SEC = 2_592_000;

type IdempotencyRecord<T> =
  | { status: "pending"; lockedAt: number }
  | { status: "completed"; result: T; completedAt: number };

export type IdempotentOutcome<T> =
  | { outcome: "created"; result: T }
  | { outcome: "replayed"; result: T }
  | { outcome: "in_flight" };

/**
 * Deterministic JSON serialization: object keys sorted recursively,
 * `undefined` properties omitted, array order preserved (arrays are
 * ordered; objects are not). Pure function.
 */
export function stableSerialize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) {
        out[key] = sortDeep(source[key]);
      }
    }
    return out;
  }
  return value;
}

/**
 * Content-addressed idempotency key for a GitHub issue proposal.
 *
 * Labels are normalized before hashing: `undefined` hashes identically
 * to `[]` (the legacy message parser yields undefined where batch
 * records hold an array), and order is ignored (labels are a set on
 * GitHub). Pure function.
 */
export function issueIdempotencyKey(proposal: {
  title: string;
  body: string;
  labels?: string[];
}): string {
  const canonical = stableSerialize({
    title: proposal.title,
    body: proposal.body,
    labels: [...(proposal.labels ?? [])].sort(),
  });
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `idem:issue:${digest}`;
}

/**
 * Execute `fn` at most once per idempotency key (see the protocol in
 * the file header). Returns a discriminated outcome so callers can
 * distinguish a fresh create from a replay and from a concurrent
 * in-flight execution.
 *
 * @param key   Idempotency key (from issueIdempotencyKey).
 * @param fn    The side-effecting operation to guard.
 * @param logFn Logger — pass the request-scoped rlog when available.
 */
export async function executeIdempotent<T>(
  key: string,
  fn: () => Promise<T>,
  logFn: LogFn = log,
): Promise<IdempotentOutcome<T>> {
  // ── Phase 1: read + lock. Any KV failure here fails open. ──────────
  try {
    const existing = await kv.get<IdempotencyRecord<T>>(key);
    if (existing && existing.status === "completed") {
      logFn("idempotency_replayed", { key });
      return { outcome: "replayed", result: existing.result };
    }

    const acquired = await kv.set(
      key,
      { status: "pending", lockedAt: Date.now() },
      { nx: true, ex: LOCK_TTL_SEC },
    );
    if (acquired === null) {
      // Lost the NX race. Re-read AFTER the atomic op: a competitor may
      // have completed in the window between our GET and our SET —
      // replay their result rather than giving up or re-creating.
      const current = await kv.get<IdempotencyRecord<T>>(key);
      if (current && current.status === "completed") {
        logFn("idempotency_replayed", { key });
        return { outcome: "replayed", result: current.result };
      }
      logFn("idempotency_in_flight", { key });
      return { outcome: "in_flight" };
    }
  } catch (err) {
    // KV outage — fail open: run fn unguarded, skip all record writes.
    logFn("idempotency_degraded", {
      key,
      phase: "lock",
      errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    const result = await fn();
    return { outcome: "created", result };
  }

  // ── Phase 2: we hold the pending lock — run fn. ─────────────────────
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    // Release the lock so a subsequent confirmation can retry; nothing
    // was created. Best-effort — the 60s TTL is the backstop.
    try {
      await kv.del(key);
    } catch (delErr) {
      logFn("idempotency_degraded", {
        key,
        phase: "unlock",
        errorMessage:
          delErr instanceof Error ? delErr.message.slice(0, 200) : String(delErr),
      });
    }
    throw err;
  }

  // ── Phase 3: persist the completed record. NEVER throw post-success:
  // the issue exists — a KV flake here must not surface as a failure. ──
  try {
    await kv.set(
      key,
      { status: "completed", result, completedAt: Date.now() },
      { ex: COMPLETED_TTL_SEC },
    );
  } catch (err) {
    logFn("idempotency_degraded", {
      key,
      phase: "record",
      errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
  }
  return { outcome: "created", result };
}
