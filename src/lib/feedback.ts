import { kv } from "./kv";
import type { Reference } from "@/tools";

/**
 * Feedback System — Vercel KV storage
 *
 * Stores 👍/👎 reaction feedback on bot responses.
 * Feedback shapes future answers via the system prompt.
 *
 * Two data structures:
 * 1. "feedback:context:{channel}:{ts}" — stores the Q&A context for each
 *     bot-posted chunk. Multi-chunk answers write one record per chunk
 *     TS so reactions on ANY chunk resolve to the same answer context
 *     (see #114).
 * 2. "feedback:entries" — sorted set of feedback entries (like knowledge
 *     base); rendered into the system prompt to shape future answers.
 */

const CONTEXT_PREFIX = "feedback:context";
const FEEDBACK_KEY = "feedback:entries";
const CONTEXT_TTL = 86400 * 7; // 7 days — after that, reactions are ignored
const MAX_FEEDBACK_ENTRIES_IN_PROMPT = 30;

export interface QAContext {
  question: string;
  answer: string;
  references: string[]; // file paths or issue numbers accessed
  // ── Observability + cross-chunk reaction resolution (#114) ──────────
  answerTs: string; // chunk 0 ts — stable identifier for the whole answer
  chunkIndex: number; // 0-based position of the chunk this record indexes
  chunkCount: number; // total chunks posted for this answer
  postedAt: number; // Date.now() at post time — used to compute reaction latency
  referenceTypes: string[]; // ["file","doc","issue",...] derived from the Reference[]
}

export interface FeedbackEntry {
  type: "positive" | "negative";
  question: string;
  detail: string; // what worked (positive) or what was wrong (negative)
  timestamp: string;
}

export interface FeedbackSummary {
  markdown: string;
  positiveCount: number;
  negativeCount: number;
  totalEntries: number; // count of entries actually included (post-cap)
}

/**
 * Derive the set of reference TYPES present in a Reference[] — sorted
 * unique types. Used for observability events to bucket "what kinds of
 * sources produced feedback-worthy answers".
 *
 * Pure function.
 */
export function deriveReferenceTypes(refs: Reference[]): string[] {
  const unique = new Set<string>();
  for (const r of refs) unique.add(r.type);
  return [...unique].sort();
}

/**
 * Store the Q&A context for a single chunk's TS. Callers are expected
 * to invoke this once per chunk when splitting a long answer; each call
 * passes the same shared context with its own `chunkIndex`.
 */
export async function storeQAContext(
  channel: string,
  messageTs: string,
  context: QAContext,
): Promise<void> {
  const key = `${CONTEXT_PREFIX}:${channel}:${messageTs}`;
  await kv.set(key, context, { ex: CONTEXT_TTL });
}

/**
 * Retrieve the Q&A context for a bot message. Returns the context
 * whether the user reacted on chunk 0 or a later chunk — all chunks of
 * the same answer share the same question/answer/references but carry
 * their own chunkIndex.
 */
export async function getQAContext(
  channel: string,
  messageTs: string,
): Promise<QAContext | null> {
  const key = `${CONTEXT_PREFIX}:${channel}:${messageTs}`;
  try {
    return (await kv.get<QAContext>(key)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Save a feedback entry (positive or negative).
 */
export async function saveFeedback(entry: FeedbackEntry): Promise<void> {
  const timestamp = Date.now();
  await kv.zadd(FEEDBACK_KEY, {
    score: timestamp,
    member: JSON.stringify(entry),
  });
}

// ── Pure formatter (extracted so it's unit-testable) ──────────────────
// Returns the prompt markdown plus counts — emit the counts as an
// observability event from the caller so we can see per-turn how much
// feedback context the model saw.
export function formatFeedbackSummary(
  entries: FeedbackEntry[],
): FeedbackSummary | null {
  if (entries.length === 0) return null;

  // Cap BEFORE counting so counts reflect what went into the prompt,
  // not raw storage.
  const capped = entries.slice(0, MAX_FEEDBACK_ENTRIES_IN_PROMPT);

  const positives = capped.filter((e) => e.type === "positive");
  const negatives = capped.filter((e) => e.type === "negative");

  const lines: string[] = [];
  if (positives.length > 0) {
    lines.push("*What worked well (do more of this):*");
    for (const e of positives) {
      lines.push(`- [${e.timestamp}] Q: "${e.question.slice(0, 80)}" → ${e.detail}`);
    }
  }
  if (negatives.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("*What needed correction (avoid repeating):*");
    for (const e of negatives) {
      lines.push(`- [${e.timestamp}] Q: "${e.question.slice(0, 80)}" → ${e.detail}`);
    }
  }

  return {
    markdown: lines.join("\n"),
    positiveCount: positives.length,
    negativeCount: negatives.length,
    totalEntries: capped.length,
  };
}

/**
 * Fetch feedback entries from KV and return a summary suitable for both
 * prompt injection and observability logging. Callers should emit a
 * `prompt_feedback_included` log event with the returned counts.
 *
 * Returns null if no entries exist (nothing to inject).
 */
export async function getFeedbackSummary(): Promise<FeedbackSummary | null> {
  try {
    const raw = await kv.zrange(FEEDBACK_KEY, 0, -1, { rev: true });
    const entries = (raw as string[]).map((item) => {
      try {
        return JSON.parse(item) as FeedbackEntry;
      } catch {
        return null;
      }
    }).filter(Boolean) as FeedbackEntry[];
    return formatFeedbackSummary(entries);
  } catch {
    return null;
  }
}

/**
 * Back-compat shim for callers that only want the markdown (e.g.
 * assembleSystemPrompt in claude.ts). New callers should prefer
 * `getFeedbackSummary()` so they can surface the counts.
 */
export async function getFeedbackAsMarkdown(): Promise<string | null> {
  const summary = await getFeedbackSummary();
  return summary?.markdown ?? null;
}
