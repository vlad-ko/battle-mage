/**
 * Deterministic provenance gate for passive KB candidates (#136).
 *
 * The extractor (kb-extract.ts) is a fast model and therefore
 * untrusted: it can hallucinate entries, cite indices that don't exist,
 * or "learn" something the bot itself said. This module is the
 * NON-LLM gate between the extractor and the proposal message — every
 * rule here is a pure, exhaustively unit-tested predicate.
 *
 * Keep this file side-effect-free: no KV, no Slack, no clock. All
 * imports from stateful modules are type-only.
 */

import { createHash } from "crypto";
import type { KbCandidate, TranscriptEntry } from "./kb-extract";
import type { KnowledgeEntry } from "./knowledge";

/** Minimum extractor confidence to survive the gate. `>=` passes. */
export const KB_CANDIDATE_MIN_CONFIDENCE = 0.75;

/** Maximum entry length (inclusive) — KB entries are single durable
 *  statements, not essays. */
export const MAX_KB_ENTRY_CHARS = 500;

/**
 * Prefix of the bot's "correction saved" confirmation reply (posted by
 * turn-runner.ts). The gate scans bot transcript lines for this prefix
 * to avoid re-proposing something the thread already saved explicitly.
 * turn-runner imports this constant so the two stay in lock-step.
 */
export const KB_SAVED_CONFIRMATION_PREFIX =
  ":white_check_mark: Saved to knowledge base:";

// ── Normalization + hashing ───────────────────────────────────────────

/**
 * Canonical text form for dedup: lowercase, punctuation → space,
 * whitespace collapsed, trimmed. Pure function.
 */
export function normalizeKbText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Content hash of the NORMALIZED entry text — the stable identity a
 *  candidate keeps across re-extractions and cosmetic rewording. */
export function kbCandidateHash(text: string): string {
  return createHash("sha256").update(normalizeKbText(text)).digest("hex");
}

// ── Contradiction matching (#124 composition) ─────────────────────────

// Words too common to signal topical overlap. Mirrors the list in
// auto-correct.ts's identifyStaleKBEntries.
const COMMON_WORDS = new Set([
  "the", "is", "in", "not", "and", "or", "a", "an", "to", "of", "for",
  "it", "was", "that", "with",
]);

function meaningfulWords(text: string): string[] {
  return normalizeKbText(text)
    .split(" ")
    .filter((w) => w.length > 2 && !COMMON_WORDS.has(w));
}

/**
 * Visible KB entries a correction-shaped candidate likely contradicts,
 * matched on meaningful keyword overlap (identifyStaleKBEntries style).
 * This is an ANNOTATION for the save flow (mark superseded on confirm),
 * never a drop reason. Pure function.
 */
export function matchContradictedEntries(
  candidateEntry: string,
  visibleKb: KnowledgeEntry[],
): KnowledgeEntry[] {
  if (visibleKb.length === 0) return [];
  const keywords = new Set(meaningfulWords(candidateEntry));
  if (keywords.size === 0) return [];
  return visibleKb.filter((e) =>
    meaningfulWords(e.entry).some((w) => keywords.has(w)),
  );
}

// ── Channel eligibility ───────────────────────────────────────────────

/**
 * Only PUBLIC channels are extractable — passive learning must never
 * lift content out of private channels, DMs, or group DMs into a KB
 * that surfaces everywhere. FAIL CLOSED: publicness must be positively
 * confirmed (all three flags present and false); missing flags reject.
 * Pure function — the orchestrator fetches conversations.info.
 */
export function isExtractableChannel(info: {
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
}): boolean {
  return info.is_private === false && info.is_im === false && info.is_mpim === false;
}

// ── The gate ──────────────────────────────────────────────────────────

export type KbDropReason =
  | "empty_entry"
  | "entry_too_long"
  | "low_confidence"
  | "no_evidence"
  | "evidence_out_of_range"
  | "no_human_evidence"
  | "already_saved_in_thread"
  | "duplicate_kb"
  | "already_proposed";

export interface EligibleKbCandidate extends KbCandidate {
  /** kbCandidateHash of the entry — dedup identity across quiet periods. */
  hash: string;
  /** Verbatim transcript texts of the cited evidence indices. */
  evidenceQuotes: string[];
  /** For correction-kind candidates: visible KB entry TEXTS this
   *  candidate likely contradicts (retired on confirm, #124). Always []
   *  for fact/decision kinds. */
  flaggedKbEntries: string[];
}

export interface GateKbCandidatesParams {
  candidates: KbCandidate[];
  transcript: TranscriptEntry[];
  /** VISIBLE KB entries only — retired (superseded/archived) entries
   *  must never block re-learning, so the caller filters first. */
  visibleKb: KnowledgeEntry[];
  /** Hashes already proposed for this thread in prior quiet periods. */
  alreadyProposedHashes: string[];
}

export interface GateKbCandidatesResult {
  eligible: EligibleKbCandidate[];
  dropped: { candidate: KbCandidate; reason: KbDropReason }[];
}

/**
 * Extract the saved-entry snippets from bot "saved to knowledge base"
 * confirmations in the transcript, normalized. The confirmation itself
 * truncates the entry to 100 chars, so callers must match by
 * containment, not equality.
 */
function savedConfirmationSnippets(transcript: TranscriptEntry[]): string[] {
  const snippets: string[] = [];
  for (const entry of transcript) {
    if (entry.author !== "bot") continue;
    const at = entry.text.indexOf(KB_SAVED_CONFIRMATION_PREFIX);
    if (at === -1) continue;
    const normalized = normalizeKbText(
      entry.text.slice(at + KB_SAVED_CONFIRMATION_PREFIX.length),
    );
    if (normalized.length > 0) snippets.push(normalized);
  }
  return snippets;
}

/** Containment in either direction — covers KB entries that embed the
 *  candidate in extra framing AND truncated confirmation snippets. */
function eitherContains(a: string, b: string): boolean {
  return a.includes(b) || b.includes(a);
}

/**
 * Apply the deterministic provenance rules to a batch of extractor
 * candidates. Drop-reason precedence is PINNED (tests assert it):
 *
 *   empty_entry → entry_too_long → low_confidence → no_evidence →
 *   evidence_out_of_range → no_human_evidence → already_saved_in_thread
 *   → duplicate_kb → already_proposed
 *
 * Pure function — no clock, no I/O.
 */
export function gateKbCandidates(
  params: GateKbCandidatesParams,
): GateKbCandidatesResult {
  const { candidates, transcript, visibleKb, alreadyProposedHashes } = params;
  const eligible: EligibleKbCandidate[] = [];
  const dropped: { candidate: KbCandidate; reason: KbDropReason }[] = [];

  const savedSnippets = savedConfirmationSnippets(transcript);
  const visibleNormalized = visibleKb
    .map((e) => normalizeKbText(e.entry))
    .filter((t) => t.length > 0);
  const seenHashes = new Set(alreadyProposedHashes);

  const drop = (candidate: KbCandidate, reason: KbDropReason) =>
    dropped.push({ candidate, reason });

  for (const candidate of candidates) {
    if (candidate.entry.trim().length === 0) {
      drop(candidate, "empty_entry");
      continue;
    }
    if (candidate.entry.length > MAX_KB_ENTRY_CHARS) {
      drop(candidate, "entry_too_long");
      continue;
    }
    if (candidate.confidence < KB_CANDIDATE_MIN_CONFIDENCE) {
      drop(candidate, "low_confidence");
      continue;
    }
    if (candidate.evidence.length === 0) {
      drop(candidate, "no_evidence");
      continue;
    }
    // Fail closed: ONE bad index kills the candidate — a model that
    // fabricates any citation can't be trusted on the others.
    const outOfRange = candidate.evidence.some(
      (i) => !Number.isInteger(i) || i < 0 || i >= transcript.length,
    );
    if (outOfRange) {
      drop(candidate, "evidence_out_of_range");
      continue;
    }
    const cited = candidate.evidence.map((i) => transcript[i]);
    if (!cited.some((e) => e.author === "human")) {
      drop(candidate, "no_human_evidence");
      continue;
    }

    const normalized = normalizeKbText(candidate.entry);
    if (savedSnippets.some((s) => eitherContains(s, normalized))) {
      drop(candidate, "already_saved_in_thread");
      continue;
    }
    if (visibleNormalized.some((v) => eitherContains(v, normalized))) {
      drop(candidate, "duplicate_kb");
      continue;
    }

    const hash = kbCandidateHash(candidate.entry);
    if (seenHashes.has(hash)) {
      drop(candidate, "already_proposed");
      continue;
    }
    seenHashes.add(hash);

    eligible.push({
      ...candidate,
      hash,
      evidenceQuotes: cited.map((e) => e.text),
      flaggedKbEntries:
        candidate.kind === "correction"
          ? matchContradictedEntries(candidate.entry, visibleKb).map((e) => e.entry)
          : [],
    });
  }

  return { eligible, dropped };
}
