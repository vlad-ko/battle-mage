/**
 * Thread-history compaction.
 *
 * When a Slack thread with the bot grows long, every follow-up replays the
 * entire history to Claude. A 30-turn QA thread racks up tokens fast and
 * also dilutes the model's focus on the current question. Compaction
 * summarizes older turns into a block of leading context that's embedded
 * INSIDE the first preserved user turn (prefixed with COMPACTION_MARKER)
 * — NOT a synthetic assistant message, which would break Anthropic's
 * "first message must be role=user" invariant.
 *
 * Design choices (vs junior's reference):
 * - One-shot compaction, not rolling. If threads ever compact twice we'll
 *   revisit; today's QA-shaped threads rarely exceed the trigger.
 * - Character-based trigger (not tokens). `estimateConversationSize` sums
 *   `content.length`; cheaper than tokenization and good enough as a gate.
 * - Fail-safe: if the compactor throws, return the original history and
 *   log the failure. A failed compaction must never abort the user's turn.
 *
 * Runs on FAST_MODEL (Haiku 4.5) — see #75. Haiku handles summarization
 * quality well and is ~5x cheaper + ~2x faster than Sonnet for this shape
 * of work.
 */

import Anthropic from "@anthropic-ai/sdk";
import { FAST_MODEL, type ConversationTurn } from "@/lib/claude";
import { log as defaultLog, type RequestLogger } from "@/lib/logger";

// Shared client. Same instance as claude.ts via singleton at module-eval
// time. Reads ANTHROPIC_API_KEY from env.
const anthropic = new Anthropic();

/** Total characters above which compaction runs, provided there are more
 *  than MIN_PRESERVED_TURNS turns. Roughly 60k chars ≈ 15k tokens. */
export const THREAD_COMPACTION_TRIGGER_CHARS = 60_000;

/** Number of most recent turns to preserve verbatim (never compact). */
export const MIN_PRESERVED_TURNS = 6;

/** Prefix attached to the synthetic summary turn so downstream code (and
 *  the model itself) can distinguish it from a real prior assistant turn. */
export const COMPACTION_MARKER = "[Conversation summary — earlier turns condensed]";

const COMPACTION_PROMPT = `You are condensing the earlier portion of a Slack conversation between a user and a coding assistant bot for your own later reference.

Write a concise summary that preserves:
- Topics discussed (what was the user trying to understand or achieve?)
- Key facts the assistant confirmed or corrected
- File paths, issue numbers, PR numbers, or commits referenced
- Any decisions or next steps agreed upon
- Open loops or unresolved questions

Format: a single paragraph, 3-6 sentences. No headings, no bullets, under 300 words. Write in third person ("The user asked about…", "The assistant confirmed…").

Conversation to summarize:
---
<TRANSCRIPT>
---`;

export function estimateConversationSize(history: ConversationTurn[]): number {
  let n = 0;
  for (const t of history) n += t.content.length;
  return n;
}

export function shouldCompact(history: ConversationTurn[]): boolean {
  return (
    history.length > MIN_PRESERVED_TURNS &&
    estimateConversationSize(history) > THREAD_COMPACTION_TRIGGER_CHARS
  );
}

export interface CompactContext {
  /** Logger for thread_compacted / thread_compaction_error events. */
  log?: RequestLogger;
  /** Injectable compactor for tests. In prod defaults to a Haiku call. */
  compactor?: (prompt: string) => Promise<string>;
}

export async function compactThread(
  history: ConversationTurn[],
  ctx: CompactContext = {},
): Promise<ConversationTurn[]> {
  if (history.length <= MIN_PRESERVED_TURNS) return history;

  const log = ctx.log ?? defaultLog;
  const compactor = ctx.compactor ?? defaultCompactor;

  // Split into compact window (older) and preserve window (recent).
  // Anthropic requires the first message to be `user` AND alternation
  // between user/assistant. We embed the summary INTO the first
  // preserved user turn so the sequence stays valid after compaction:
  // no synthetic roles, no alternation breaks.
  //
  // If the natural preserve slice (last N) starts with `assistant`
  // (history was misaligned — e.g. odd total count), extend preserve by
  // one turn EARLIER (include one additional user turn) so preserve[0]
  // is always `user`. We never under-preserve: preserved.length is
  // always >= MIN_PRESERVED_TURNS, not less.
  let preserveCount = MIN_PRESERVED_TURNS;
  if (
    history.length > MIN_PRESERVED_TURNS &&
    history[history.length - MIN_PRESERVED_TURNS].role === "assistant"
  ) {
    preserveCount = MIN_PRESERVED_TURNS + 1;
  }
  const toCompact = history.slice(0, -preserveCount);
  const preserve = history.slice(-preserveCount);

  // After the shift, if there are still no older turns to compact, bail.
  if (toCompact.length === 0 || preserve.length === 0) return history;

  const transcript = toCompact
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");

  const prompt = COMPACTION_PROMPT.replace("<TRANSCRIPT>", transcript);

  let summary: string;
  try {
    summary = await compactor(prompt);
  } catch (err) {
    // Fail-safe: logging failure and returning original history is better
    // than aborting the user's turn. The caller will run the agent with
    // the uncompacted (expensive but correct) history.
    log("thread_compaction_error", {
      message: err instanceof Error ? err.message : String(err),
      model: FAST_MODEL,
      turns_attempted: toCompact.length,
    });
    return history;
  }

  // Prepend the summary as leading context to the first preserved user
  // turn. The COMPACTION_MARKER prefix lets downstream code (and the
  // model) distinguish injected context from the user's actual words.
  const firstUser = preserve[0];
  const enhancedFirst: ConversationTurn = {
    role: "user",
    content: `${COMPACTION_MARKER}\n${summary}\n\n---\n\n${firstUser.content}`,
  };
  const compacted = [enhancedFirst, ...preserve.slice(1)];

  const charsBefore = estimateConversationSize(history);
  const charsAfter = estimateConversationSize(compacted);
  log("thread_compacted", {
    turns_compacted: toCompact.length,
    turns_preserved: preserve.length,
    chars_before: charsBefore,
    chars_after: charsAfter,
    // Rough ~4 chars/token heuristic so operators get a token-shaped
    // mental unit alongside the char count. Good enough for dashboards;
    // not a replacement for the SDK's actual usage.input_tokens number.
    estimated_tokens_before: Math.round(charsBefore / 4),
    estimated_tokens_after: Math.round(charsAfter / 4),
    model: FAST_MODEL,
  });

  return compacted;
}

async function defaultCompactor(prompt: string): Promise<string> {
  const resp = await anthropic.messages.create({
    model: FAST_MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
  return resp.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}
