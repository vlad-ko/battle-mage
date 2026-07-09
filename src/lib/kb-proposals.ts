/**
 * Passive KB learning — pure proposal-lifecycle helpers (#136).
 *
 * Key builders, the per-thread extraction decision, and the two Slack
 * message formatters. Keep this file side-effect-free — kb-runner.ts
 * owns all KV/Slack I/O; this module only produces strings and
 * classifies state, mirroring the issue-batch.ts / recovery.ts split.
 *
 * Storage model (all keys namespaced away from processing:* and
 * pending-issue-batch:*):
 *
 * - `kb-extract:index` — discovery zset, member `<channel>:<threadTs>`
 *   (recovery.ts indexMember format), score = last bot-answer time.
 *   Bumped best-effort by recordKbThreadActivity after every
 *   answer_posted; NEVER bumped by the KB proposal post itself.
 * - `kb-extract:state:{ch}:{ts}` — per-thread extraction state, 30d TTL.
 * - `kb-extract:claim:{ch}:{ts}` — non-destructive SET NX sweep claim
 *   (clone of recovery.ts acquireSweepClaim), 120s TTL.
 * - `pending-kb-batch:{ch}:{firstTs}` — proposed batch awaiting human
 *   confirmation, 24h TTL. `:thread:` pointer enables "confirm all"
 *   text; `:done:` tombstone (1h) absorbs double-tap ✅.
 */

import type { EligibleKbCandidate } from "./kb-gate";

// ── Constants ─────────────────────────────────────────────────────────

/** Discovery zset: member `<channel>:<threadTs>`, score last-activity ms. */
export const KB_EXTRACT_INDEX_KEY = "kb-extract:index";

/** A thread is "concluded" after this much quiet time: 4 hours. */
export const KB_EXTRACT_IDLE_MS = 14_400_000;

/** Extraction budget per sweep — each extraction is a model call with a
 *  10s cap, and the sweep shares its budget with recovery work. */
export const MAX_KB_EXTRACT_PER_SWEEP = 3;

/** Discovery-scan window per sweep (PR #139): the sweep reads only the
 *  first N zset members ASCENDING by score. Score = last activity, so
 *  the window holds the oldest/most-idle threads — exactly the
 *  extract/prune candidates. Recent members past the window are simply
 *  untouched until they age into it; a full (0, -1) scan is O(n). */
export const KB_EXTRACT_SCAN_LIMIT = 50;

/** Failed extraction attempts before the thread is given up on
 *  (until new activity re-arms it). `>=` gives up. */
export const MAX_KB_EXTRACTION_ATTEMPTS = 2;

/** TTL on the per-thread extraction state record: 30 days. */
export const KB_STATE_TTL_SEC = 2_592_000;

/** TTL on the sweep's per-thread NX claim — mirrors recovery.ts's
 *  SWEEP_CLAIM_TTL_SEC rationale: covers one extraction (10s model cap
 *  + gate + Slack post) with slack, and an abandoned claim delays the
 *  thread by at most one sweep cadence. */
export const KB_EXTRACT_CLAIM_TTL_SEC = 120;

/** TTL on a pending KB proposal batch: 24h, matching issue batches. */
export const KB_BATCH_TTL_SEC = 86_400;

/** Tombstone TTL after a batch is claimed — absorbs double-tap ✅
 *  (same rationale as issue-batch tombstones, PR #123). */
export const KB_BATCH_TOMBSTONE_TTL_SEC = 3_600;

// ── Key builders (pure) ───────────────────────────────────────────────

export function kbStateKey(channel: string, threadTs: string): string {
  return `kb-extract:state:${channel}:${threadTs}`;
}
export function kbClaimKey(channel: string, threadTs: string): string {
  return `kb-extract:claim:${channel}:${threadTs}`;
}
export function kbBatchKey(channel: string, firstTs: string): string {
  return `pending-kb-batch:${channel}:${firstTs}`;
}
export function kbBatchThreadPointerKey(channel: string, threadTs: string): string {
  return `pending-kb-batch:thread:${channel}:${threadTs}`;
}
export function kbBatchTombstoneKey(channel: string, firstTs: string): string {
  return `pending-kb-batch:done:${channel}:${firstTs}`;
}

// ── Per-thread state + extraction decision ───────────────────────────

export interface KbThreadState {
  /** covered — extraction ran and this quiet period is handled;
   *  failed — the extractor returned null, retry next sweep (< cap);
   *  gave_up — attempt cap reached; re-arms only on new activity. */
  status: "covered" | "failed" | "gave_up";
  /** When the last extraction attempt ran (ms epoch). */
  extractedAt: number;
  /** Consecutive failed attempts for the CURRENT quiet period. */
  attempt: number;
  /** kbCandidateHash of every candidate ever proposed for this thread —
   *  the already_proposed gate input across quiet periods. */
  proposedHashes: string[];
}

export type KbExtractionAction = "wait" | "extract" | "prune" | "give_up";

/**
 * Classify one indexed thread for the sweep. Pure function.
 *
 * Rule order (pinned by tests):
 * - age <= idleMs — INCLUDING a future lastActivityAt (clock skew must
 *   never trigger extraction)                                → "wait"
 * - no state (never extracted, now idle)                     → "extract"
 * - failed, attempt >= maxAttempts                           → "give_up"
 * - failed, attempt < maxAttempts                            → "extract"
 * - covered/gave_up with no activity since the last attempt
 *   (extractedAt >= lastActivityAt)                          → "prune"
 * - covered/gave_up with NEW activity + a fresh quiet period → "extract"
 *   (at most once per quiet period; the runner carries proposedHashes
 *   forward and resets attempt on a gave_up re-arm)
 */
export function decideKbExtraction(
  state: KbThreadState | null,
  lastActivityAt: number,
  now: number,
  idleMs: number = KB_EXTRACT_IDLE_MS,
  maxAttempts: number = MAX_KB_EXTRACTION_ATTEMPTS,
): KbExtractionAction {
  const age = now - lastActivityAt;
  if (age <= idleMs) return "wait";
  if (!state) return "extract";
  if (state.status === "failed") {
    return state.attempt >= maxAttempts ? "give_up" : "extract";
  }
  // covered | gave_up: prune once the quiet period is consumed;
  // re-extract (re-arm) when the thread saw activity after the attempt.
  return state.extractedAt >= lastActivityAt ? "prune" : "extract";
}

// ── Pending-batch record ──────────────────────────────────────────────

/** Stored under pending-kb-batch:{channel}:{firstTs}. Mirrors
 *  PendingIssueBatch (turn-runner.ts). */
export interface PendingKbBatch {
  candidates: EligibleKbCandidate[];
  proposedAt: number;
  channel: string;
  threadTs: string;
  /** ts of the proposal message (the ✅ target and batch key). */
  messageFirstTs: string;
}

// ── Slack mention-token escaping (PR #139 security finding) ─────────

/**
 * Neutralize Slack control sequences in model-produced / user-quoted
 * text before it is posted. Candidate entries, evidence quotes, and
 * flagged KB texts come from an untrusted extractor reading arbitrary
 * thread content — a literal `<!channel>`, `<!here>`, `<@U…>`, or
 * `<#C…>` in any of them would trigger real pings when posted.
 *
 * Per Slack's escaping rules only three characters need encoding, and
 * `&` MUST go first so pre-existing entities double-escape predictably:
 * `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`. This neutralizes ALL
 * `<…>` control sequences (mentions, broadcasts, channel links, URLs).
 * Pure function.
 */
export function escapeSlackMentions(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Proposal message formatter ────────────────────────────────────────

const DIVIDER = "───────────────────";
const KB_CONFIRM_LINE =
  "React with :white_check_mark: or say *confirm all* to save these to the knowledge base. Ignore to discard.";

/**
 * Render a KB proposal batch for Slack. Returns "" for zero candidates
 * (empty fan-out posts nothing).
 *
 * MUST NOT contain issue-batch.ts's SINGLE_PROPOSAL_ANCHOR or
 * BATCH_PROPOSAL_HEADER — the legacy ✅ text parser keys on those, and
 * a KB proposal must never be mistaken for an issue proposal (tested).
 */
export function formatKbProposalMessage(
  candidates: EligibleKbCandidate[],
): string {
  if (candidates.length === 0) return "";

  const lines: string[] = [
    DIVIDER,
    `:books: *Proposed knowledge-base entries* — learned from this thread. ${KB_CONFIRM_LINE}`,
    "",
  ];
  candidates.forEach((c, i) => {
    // Everything model-produced or thread-quoted is escaped — see
    // escapeSlackMentions above (PR #139 security finding).
    lines.push(`${i + 1}. _"${escapeSlackMentions(c.entry)}"_ (${c.kind})`);
    for (const quote of c.evidenceQuotes) {
      lines.push(`    > ${escapeSlackMentions(quote)}`);
    }
    if (c.flaggedKbEntries.length > 0) {
      lines.push(
        `    ↳ retires: ${c.flaggedKbEntries.map((e) => `_"${escapeSlackMentions(e)}"_`).join(", ")}`,
      );
    }
  });
  return lines.join("\n");
}

// ── Save-result summary formatter ────────────────────────────────────

export type KbSaveOutcome =
  | { status: "saved"; entry: string; id: string; supersededCount: number }
  | { status: "error"; entry: string; errorMessage: string };

/** Summarize per-entry save outcomes for the confirmation reply.
 *  Returns "" for no outcomes. */
export function summarizeKbSaveResult(outcomes: KbSaveOutcome[]): string {
  if (outcomes.length === 0) return "";

  const saved = outcomes.filter(
    (o): o is Extract<KbSaveOutcome, { status: "saved" }> => o.status === "saved",
  );
  const failed = outcomes.filter(
    (o): o is Extract<KbSaveOutcome, { status: "error" }> => o.status === "error",
  );

  const lines: string[] = [];
  if (saved.length > 0) {
    const noun = saved.length === 1 ? "entry" : "entries";
    lines.push(`:white_check_mark: Saved ${saved.length} ${noun} to the knowledge base:`);
    for (const s of saved) {
      const retired =
        s.supersededCount > 0
          ? ` — retired ${s.supersededCount} stale ${s.supersededCount === 1 ? "entry" : "entries"}`
          : "";
      lines.push(`  • _"${escapeSlackMentions(s.entry)}"_${retired}`);
    }
  }
  if (failed.length > 0) {
    if (lines.length > 0) lines.push("");
    const noun = failed.length === 1 ? "entry" : "entries";
    lines.push(`:warning: ${failed.length} ${noun} failed to save:`);
    for (const f of failed) {
      lines.push(`  • _"${escapeSlackMentions(f.entry)}"_ — ${f.errorMessage}`);
    }
  }
  return lines.join("\n");
}
