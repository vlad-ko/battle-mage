// ── Recoverable background processing (#125) ─────────────────────────
// Vercel can kill a container mid-after() (timeout, OOM, platform
// restart) — the user's question then silently dies: no answer, no
// error reply, no trace beyond a dangling thinking message. This module
// makes in-flight turns durable:
//
// 1. The Slack route writes a ProcessingMarker as the FIRST step of
//    each after() body (off the ack path — Slack's 3-second deadline,
//    PR #133 review) and clears it in the after() finally. A finally
//    covers every handled error path — only container death leaves a
//    marker behind, which is exactly the recoverable set (minus the
//    tiny accepted window between the ack and the marker write).
// 2. A cron sweep (/api/cron/sweep, every 5 min) walks the discovery
//    index, classifies each marker via decideSweepAction, wins a
//    non-destructive NX claim per member (see acquireSweepClaim),
//    retries stale first-attempt turns once, and posts a visible
//    failure notice when the retry also died.
//
// Discovery uses a zset (processing:index, member <channel>:<threadTs>,
// score startedAt) because the kv wrapper deliberately exposes no SCAN.
//
// Invariant I4: PROCESSING_MAX_AGE_MS strictly exceeds the Slack
// route's maxDuration, so a marker older than max-age CANNOT belong to
// a live invocation — the structural guard against the sweep
// double-answering a still-running turn.

import { kv } from "./kv";
import { log } from "./logger";

/** Safety TTL on the marker record itself: 24h. The sweep normally
 * consumes markers long before this — the TTL is the backstop against
 * a permanently broken sweep leaking KV records. */
export const PROCESSING_MARKER_TTL_SEC = 86_400;

/** A marker older than this is stale (its invocation is provably dead
 * — see invariant I4 above). 15 minutes. */
export const PROCESSING_MAX_AGE_MS = 900_000;

/** Discovery zset: member `<channel>:<threadTs>`, score `startedAt`. */
export const PROCESSING_INDEX_KEY = "processing:index";

/** TTL on the sweep's per-member NX claim (PR #133 review). Must
 * comfortably cover one member's action — thread fetch + Slack reply +
 * marker rewrite — and stay well below PROCESSING_MAX_AGE_MS so an
 * abandoned claim (sweep died post-claim) delays recovery by at most
 * one cadence, never a full staleness cycle. */
export const SWEEP_CLAIM_TTL_SEC = 120;

/** The Slack route's `export const maxDuration` value. Mirrored here so
 * the recovery tests can pin the I4 invariant against it. */
export const SLACK_ROUTE_MAX_DURATION_SEC = 300;

export interface ProcessingMarker {
  eventType: "app_mention" | "thread_followup";
  channel: string;
  threadTs: string;
  user: string;
  text: string;
  startedAt: number;
  attempt: number;
  requestId: string;
}

export type SweepAction = "wait" | "retry" | "give_up" | "orphan";

/** Marker key for one in-flight turn. Pure function. */
export function processingMarkerKey(channel: string, threadTs: string): string {
  return `processing:${channel}:${threadTs}`;
}

/** Discovery-index member for one in-flight turn. Pure function. */
export function indexMember(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

/** Sweep-claim key for one in-flight turn. Pure function. */
export function sweepClaimKey(channel: string, threadTs: string): string {
  return `processing:claim:${channel}:${threadTs}`;
}

/**
 * Parse an index member back into channel + threadTs. Returns null for
 * malformed members (the sweep treats those as orphans). Splits on the
 * FIRST colon — Slack channel IDs never contain one. Pure function.
 */
export function parseIndexMember(
  member: string,
): { channel: string; threadTs: string } | null {
  const idx = member.indexOf(":");
  if (idx <= 0 || idx === member.length - 1) return null;
  return { channel: member.slice(0, idx), threadTs: member.slice(idx + 1) };
}

/**
 * Classify a marker for the sweep. Pure function.
 *
 * - null marker (index entry outlived the 24h marker TTL) → "orphan"
 * - age <= maxAgeMs (including a FUTURE startedAt — clock skew must
 *   never trigger a retry)                                → "wait"
 * - stale (age STRICTLY > maxAgeMs), attempt 0            → "retry"
 * - stale, attempt >= 1 (retry already consumed)          → "give_up"
 */
export function decideSweepAction(
  marker: ProcessingMarker | null,
  now: number,
  maxAgeMs: number = PROCESSING_MAX_AGE_MS,
): SweepAction {
  if (!marker) return "orphan";
  const age = now - marker.startedAt;
  if (age <= maxAgeMs) return "wait";
  return marker.attempt >= 1 ? "give_up" : "retry";
}

/**
 * Derive the marker for a sweep-initiated retry: attempt incremented,
 * startedAt refreshed, event payload (including requestId, kept for
 * cross-run correlation) preserved. Does not mutate the input. Pure.
 */
export function buildRetryMarker(
  marker: ProcessingMarker,
  now: number,
): ProcessingMarker {
  return { ...marker, startedAt: now, attempt: marker.attempt + 1 };
}

/**
 * Exact-match check for Vercel Cron's `Authorization: Bearer <secret>`
 * header. Fails closed: an unset or empty CRON_SECRET denies ALL
 * requests (a misconfigured deploy must not expose the sweep). Pure.
 */
export function isAuthorizedCronRequest(
  header: string | null,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  return header === `Bearer ${secret}`;
}

/**
 * Non-destructive sweep claim (PR #133 review): SET NX with a short TTL
 * on a SEPARATE key instead of deleting the marker up front. The marker
 * and index entry survive any failure after a won claim — the next
 * sweep (once the claim TTL expires) simply retries the decision. The
 * losing racer gets false and skips the member.
 *
 * KV errors propagate deliberately: the sweep's per-member catch skips
 * the member with all state intact.
 */
export async function acquireSweepClaim(
  channel: string,
  threadTs: string,
  requestId: string,
): Promise<boolean> {
  const result = await kv.set(
    sweepClaimKey(channel, threadTs),
    { claimedAt: Date.now(), requestId },
    { nx: true, ex: SWEEP_CLAIM_TTL_SEC },
  );
  // Upstash SET NX returns null when the key already exists.
  return result !== null;
}

/**
 * Persist a marker + its discovery-index entry. Best-effort: returns
 * false and logs `recovery_marker_write_failed` on KV failure — a KV
 * flake must never block the actual turn from running.
 */
export async function writeProcessingMarker(
  marker: ProcessingMarker,
): Promise<boolean> {
  try {
    await kv.set(processingMarkerKey(marker.channel, marker.threadTs), marker, {
      ex: PROCESSING_MARKER_TTL_SEC,
    });
    await kv.zadd(PROCESSING_INDEX_KEY, {
      score: marker.startedAt,
      member: indexMember(marker.channel, marker.threadTs),
    });
    return true;
  } catch (err) {
    log("recovery_marker_write_failed", {
      channel: marker.channel,
      threadTs: marker.threadTs,
      errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return false;
  }
}

/**
 * Delete a marker + its index entry. Swallows KV failures (logging
 * `recovery_marker_clear_failed`) — a clear failure must never break
 * the reply flow; the sweep's already-answered guard and the 24h TTL
 * mop up anything left behind.
 */
export async function clearProcessingMarker(
  channel: string,
  threadTs: string,
): Promise<void> {
  try {
    await kv.del(processingMarkerKey(channel, threadTs));
    await kv.zrem(PROCESSING_INDEX_KEY, indexMember(channel, threadTs));
  } catch (err) {
    log("recovery_marker_clear_failed", {
      channel,
      threadTs,
      errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
  }
}
