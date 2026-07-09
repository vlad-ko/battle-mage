/**
 * Adaptive effort routing (#126).
 *
 * Two decisions, ONE cheap Haiku structured call per turn:
 *
 * 1. shouldReply — is a thread follow-up actually addressed to the bot?
 *    The structural heuristic (bot has a prior reply in the thread) only
 *    says "maybe"; the classifier reads the last few messages and decides.
 *    FAIL-CLOSED: any error, timeout, malformed output, or low-confidence
 *    verdict means the bot stays silent. A wrongly-silent bot is a minor
 *    annoyance (re-mention it); a wrongly-chatty bot poisons the channel.
 *
 * 2. effort — bucket the question into quick | standard | deep, mapping
 *    to a per-turn tool-round budget and an answer-length target.
 *    FAIL-OPEN to "standard": a broken classifier must never degrade the
 *    answer, so anything below threshold falls back to today's behavior.
 *
 * Layering: this module imports from claude.ts (FAST_MODEL and the budget
 * constants) — never the reverse. claude.ts stays classifier-agnostic; the
 * route composes the two. Answer-length steering happens by appending
 * `buildEffortHint` to the USER message (like buildQuestionHints), keeping
 * the stable system-prompt zone byte-identical for prompt caching.
 *
 * Injection idiom copied from compaction.ts: `ClassifyDeps { call?, log? }`
 * with a private default Haiku call, so every branch is unit-testable
 * without network.
 */

import Anthropic from "@anthropic-ai/sdk";
import { FAST_MODEL, MAX_TOOL_ROUNDS, ANSWER_BUDGET_CHARS } from "@/lib/claude";
import { log as defaultLog, type LogFn } from "@/lib/logger";

// Shared client. Same singleton pattern as compaction.ts — reads
// ANTHROPIC_API_KEY from env at module-eval time.
const anthropic = new Anthropic();

/** Minimum confidence for a classifier verdict to be acted on. `>=` passes.
 *  Below this: shouldReply fails closed (silence), effort falls back to
 *  "standard". */
export const CONFIDENCE_THRESHOLD = 0.75;

/** Hard wall-clock cap on the classifier call. The follow-up gate runs
 *  BEFORE any Slack write, so a hung classifier would silently eat the
 *  turn — 3s is generous for a 256-token Haiku call. */
export const CLASSIFIER_TIMEOUT_MS = 3000;

export type EffortBucket = "quick" | "standard" | "deep";

export interface EffortBudget {
  /** Per-turn tool-round cap passed to runAgent (clamped by resolveMaxRounds). */
  maxRounds: number;
  /** Answer-length target surfaced to the model via buildEffortHint. */
  answerCharsTarget: number;
}

/** Bucket → budgets. "standard" mirrors today's defaults exactly except
 *  the round cap (10 covers virtually all observed standard turns; deep
 *  keeps the full MAX_TOOL_ROUNDS ceiling). */
export const EFFORT_BUDGETS: Record<EffortBucket, EffortBudget> = {
  quick: { maxRounds: 4, answerCharsTarget: 1200 },
  standard: { maxRounds: 10, answerCharsTarget: ANSWER_BUDGET_CHARS },
  deep: { maxRounds: MAX_TOOL_ROUNDS, answerCharsTarget: 6000 },
};

/** Where the classifier was invoked from. The two modes read shouldReply
 *  differently: a mention is an explicit invocation (shouldReply is never
 *  consulted), a follow-up is ambiguous (shouldReply is the gate). */
export type ClassifierInvocation = "mention" | "followup";

export interface TurnClassification {
  shouldReply: boolean;
  shouldReplyConfidence: number;
  effort: EffortBucket;
  effortConfidence: number;
}

export interface ClassifyInput {
  invocation: ClassifierInvocation;
  /** Preformatted recent-thread tail (see extractTranscriptTail). May be "". */
  transcript: string;
  /** The message being classified, mention-stripped. */
  question: string;
}

export interface ClassifyDeps {
  /** Injectable model call for tests. In prod defaults to a Haiku call. */
  call?: (prompt: string) => Promise<string>;
  /** Logger for turn_classified / turn_classifier_error events. */
  log?: LogFn;
}

export const TURN_CLASSIFIER_PROMPT = `You are a turn classifier for a Slack bot (@bm) that answers engineering questions about a GitHub repository. Classify the message below.

Invocation mode: <INVOCATION>
- "mention": the user explicitly @-mentioned the bot, so shouldReply is true by definition — only the effort classification matters.
- "followup": the bot already replied earlier in this thread and the user posted WITHOUT mentioning it. Decide whether the message is genuinely addressed to the bot (a question or request it should answer) versus human-to-human chatter, status updates, acknowledgements, or something meant for another person.

Effort buckets — how much repository investigation the question needs:
- "quick": trivial lookups, yes/no checks, questions the transcript already answers, single small facts.
- "standard": a typical single-topic question needing a few file reads.
- "deep": broad, comparative, or multi-part questions spanning many files — audits, "summarize our whole X", architecture reviews.

Recent thread transcript (oldest first; may be empty):
---
<TRANSCRIPT>
---

Message to classify:
---
<QUESTION>
---

Respond with ONLY a JSON object — no prose, no code fences — with exactly these four keys:
{"shouldReply": true|false, "shouldReplyConfidence": 0.0-1.0, "effort": "quick"|"standard"|"deep", "effortConfidence": 0.0-1.0}`;

// Internal sentinel so the catch block can distinguish our own timeout
// from a real API failure without string-matching error messages.
class ClassifierTimeoutError extends Error {
  constructor() {
    super(`classifier timed out after ${CLASSIFIER_TIMEOUT_MS}ms`);
  }
}

function isConfidence(v: unknown): v is number {
  // Out-of-range or NaN confidences are rejected (invalid_shape), never
  // clamped — a model emitting 1.5 is a model we shouldn't act on.
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

function validateClassification(v: unknown): TurnClassification | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.shouldReply !== "boolean") return null;
  if (!isConfidence(o.shouldReplyConfidence)) return null;
  if (!isConfidence(o.effortConfidence)) return null;
  if (o.effort !== "quick" && o.effort !== "standard" && o.effort !== "deep") return null;
  return {
    shouldReply: o.shouldReply,
    shouldReplyConfidence: o.shouldReplyConfidence,
    effort: o.effort,
    effortConfidence: o.effortConfidence,
  };
}

// Belt-and-braces: the prompt demands bare JSON, but Haiku occasionally
// wraps output in a markdown fence anyway. Strip one if present.
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

/**
 * ONE combined Haiku structured call for both decisions. NEVER throws —
 * every failure mode (API error, sync throw from an injected call,
 * timeout, malformed JSON, invalid shape) logs a `turn_classifier_error`
 * with a stable reason and returns null. Callers interpret null via
 * decideShouldReply (fail-closed) / decideEffort (fail-open to standard).
 */
export async function classifyTurn(
  input: ClassifyInput,
  deps: ClassifyDeps = {},
): Promise<TurnClassification | null> {
  const log = deps.log ?? defaultLog;
  const call = deps.call ?? defaultCall;
  const start = Date.now();

  // Replacer functions, not bare strings — String.replace treats `$&`
  // and friends in a string replacement as substitution patterns, so a
  // user message containing `$&` would garble the prompt.
  const prompt = TURN_CLASSIFIER_PROMPT.replace("<INVOCATION>", () => input.invocation)
    .replace("<TRANSCRIPT>", () => input.transcript)
    .replace("<QUESTION>", () => input.question);

  let raw: string;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    raw = await Promise.race([
      // Promise.resolve().then(...) converts a synchronously-throwing
      // injected call into a rejection instead of an escaping throw.
      Promise.resolve().then(() => call(prompt)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ClassifierTimeoutError()), CLASSIFIER_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    log("turn_classifier_error", {
      reason: err instanceof ClassifierTimeoutError ? "timeout" : "api_error",
      message: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
      model: FAST_MODEL,
    });
    return null;
  } finally {
    // Clear on the win path too — a live timer would hold the serverless
    // event loop open for the full 3s after a fast response.
    if (timer !== undefined) clearTimeout(timer);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch (err) {
    log("turn_classifier_error", {
      reason: "malformed_json",
      message: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
      model: FAST_MODEL,
    });
    return null;
  }

  const classification = validateClassification(parsed);
  if (!classification) {
    log("turn_classifier_error", {
      reason: "invalid_shape",
      message: `unexpected classifier payload: ${JSON.stringify(parsed).slice(0, 200)}`,
      duration_ms: Date.now() - start,
      model: FAST_MODEL,
    });
    return null;
  }

  log("turn_classified", {
    invocation: input.invocation,
    shouldReply: classification.shouldReply,
    shouldReplyConfidence: classification.shouldReplyConfidence,
    effort: classification.effort,
    effortConfidence: classification.effortConfidence,
    duration_ms: Date.now() - start,
    model: FAST_MODEL,
  });
  return classification;
}

/** Fail-closed gate for thread follow-ups: reply only on a confident yes. */
export function decideShouldReply(c: TurnClassification | null): boolean {
  return c !== null && c.shouldReply && c.shouldReplyConfidence >= CONFIDENCE_THRESHOLD;
}

/** Fail-open bucket pick: anything short of a confident verdict is "standard". */
export function decideEffort(c: TurnClassification | null): EffortBucket {
  if (c === null || c.effortConfidence < CONFIDENCE_THRESHOLD) return "standard";
  return c.effort;
}

/**
 * Answer-length steering appended to the USER message (never the system
 * prompt — the stable zone must stay byte-identical for prompt caching).
 * Returns "" for standard so the default path is unchanged byte-for-byte.
 */
export function buildEffortHint(effort: EffortBucket): string {
  if (effort === "quick") {
    return (
      `\n\n[Effort hint: this looks like a quick question. Answer directly with ` +
      `minimal tool use and keep the answer under ~${EFFORT_BUDGETS.quick.answerCharsTarget.toLocaleString()} characters.]`
    );
  }
  if (effort === "deep") {
    return (
      `\n\n[Effort hint: this looks like a deep question. Investigate thoroughly ` +
      `before answering; you may go up to ~${EFFORT_BUDGETS.deep.answerCharsTarget.toLocaleString()} characters if the question genuinely needs the depth.]`
    );
  }
  return "";
}

export interface FollowupEvaluation {
  /** True only on a confident shouldReply=yes. False means stay silent. */
  proceed: boolean;
  /** Raw verdict (null on classifier failure) — for decline-reason logging. */
  decision: TurnClassification | null;
  /** Resolved bucket; "standard" whenever the verdict is absent or timid. */
  effort: EffortBucket;
}

/** Composes classifyTurn → decideShouldReply → decideEffort for the
 *  follow-up path. The mention path calls classifyTurn + decideEffort
 *  directly and never consults shouldReply. */
export async function evaluateFollowup(
  input: ClassifyInput,
  deps: ClassifyDeps = {},
): Promise<FollowupEvaluation> {
  const decision = await classifyTurn(input, deps);
  return {
    proceed: decideShouldReply(decision),
    decision,
    effort: decideEffort(decision),
  };
}

async function defaultCall(prompt: string): Promise<string> {
  const resp = await anthropic.messages.create({
    model: FAST_MODEL,
    max_tokens: 256,
    messages: [{ role: "user", content: prompt }],
  });
  return resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}
