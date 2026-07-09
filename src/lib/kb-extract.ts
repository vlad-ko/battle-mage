/**
 * Passive KB extraction (#136) — transcript preparation + fast-model
 * extractor call.
 *
 * After a thread goes quiet (see kb-proposals.ts for the idle gate), the
 * sweep asks a fast model to propose knowledge-base candidates from the
 * thread transcript. Every candidate MUST cite transcript message
 * indices as evidence — the deterministic provenance gate (kb-gate.ts)
 * rejects anything it can't verify against those citations.
 *
 * Injection idiom copied from effort-routing.ts / compaction.ts:
 * `ExtractDeps { call?, log? }` with a private default Haiku call, an
 * AbortController-backed timeout, and a NEVER-throws contract — every
 * failure mode logs `kb_extraction_error` with a stable reason
 * (timeout | api_error | malformed_json | invalid_shape) and returns
 * null. The orchestrator (kb-runner.ts) interprets null as a failed
 * attempt subject to the retry cap.
 */

import Anthropic from "@anthropic-ai/sdk";
import { FAST_MODEL } from "@/lib/claude";
import { log as defaultLog, type LogFn } from "@/lib/logger";

// Shared client. Same singleton pattern as effort-routing.ts — reads
// ANTHROPIC_API_KEY from env at module-eval time.
const anthropic = new Anthropic();

/** Hard wall-clock cap on the extractor call. The extraction runs inside
 *  the cron sweep's budget alongside recovery work — a hung call must
 *  not eat the sweep. */
export const KB_EXTRACTOR_TIMEOUT_MS = 10_000;

/** Upper bound on candidates per extraction — the proposal message must
 *  stay skimmable, and anything past a handful is noise. */
export const MAX_KB_CANDIDATES = 5;

/** Most recent messages considered. Long threads keep their tail — the
 *  conclusions live at the end. */
export const MAX_EXTRACTION_MESSAGES = 60;

/** Per-message character cap in the rendered transcript. */
const MAX_ENTRY_TEXT_CHARS = 1000;

export type KbCandidateKind = "correction" | "fact" | "decision";

export interface KbCandidate {
  /** The proposed knowledge-base entry text. */
  entry: string;
  kind: KbCandidateKind;
  /** Transcript indices (see TranscriptEntry.index) that prove the claim. */
  evidence: number[];
  confidence: number;
}

/** One numbered transcript line, as both the model and the gate see it. */
export interface TranscriptEntry {
  index: number;
  author: "human" | "bot";
  /** Slack message timestamp of the underlying message. */
  ts: string;
  text: string;
}

export const KB_EXTRACTION_PROMPT = `You are a knowledge extractor for a Slack bot (@bm) that answers engineering questions about a GitHub repository. Read the thread transcript below and extract durable, reusable facts worth saving to the bot's knowledge base.

Candidate kinds:
- "correction": a human contradicted or corrected something the bot asserted.
- "fact": a durable project fact a human stated (conventions, file locations, limits, ownership).
- "decision": a decision the team reached in this thread.

Rules:
- Extract ONLY claims a HUMAN stated or confirmed in the transcript. Never extract the bot's own unconfirmed assertions.
- Every candidate MUST cite the transcript message indices (the [i] numbers) that prove it.
- Prefer a few high-confidence candidates over many weak ones. Skip pleasantries, status chatter, and one-off details.
- Each entry must be a single self-contained statement under 500 characters.

Thread transcript (each line is "[index] author: text"):
---
<TRANSCRIPT>
---

Respond with ONLY a JSON object — no prose, no code fences — of exactly this shape:
{"candidates": [{"entry": "...", "kind": "correction"|"fact"|"decision", "evidence": [message indices], "confidence": 0.0-1.0}]}
Return {"candidates": []} if nothing qualifies.`;

// ── Transcript preparation ────────────────────────────────────────────

/** Minimal message shape — structurally compatible with slack.ts's
 *  ThreadMessage. */
export interface ExtractionSourceMessage {
  user?: string;
  text?: string;
  bot_id?: string;
  ts?: string;
}

/**
 * Render a thread into the numbered transcript the extractor prompt
 * embeds. Pure function.
 *
 * Order of operations matters (and is pinned by tests):
 * 1. clean each message (strip Slack mention tokens, trim);
 * 2. SKIP empty-after-clean messages BEFORE numbering, so the indices
 *    the model cites always land on real entries;
 * 3. keep only the most recent MAX_EXTRACTION_MESSAGES;
 * 4. number 0..N-1 and cap each entry at 1000 chars + "...".
 */
export function buildExtractionTranscript(
  messages: ExtractionSourceMessage[],
  botUserId: string,
): { rendered: string; entries: TranscriptEntry[] } {
  const cleaned = messages
    .map((m) => ({
      author: (m.bot_id || m.user === botUserId ? "bot" : "human") as "human" | "bot",
      ts: m.ts ?? "",
      text: (m.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim(),
    }))
    .filter((m) => m.text.length > 0)
    .slice(-MAX_EXTRACTION_MESSAGES);

  const entries: TranscriptEntry[] = cleaned.map((m, index) => ({
    index,
    author: m.author,
    ts: m.ts,
    text:
      m.text.length > MAX_ENTRY_TEXT_CHARS
        ? m.text.slice(0, MAX_ENTRY_TEXT_CHARS) + "..."
        : m.text,
  }));

  const rendered = entries
    .map((e) => `[${e.index}] ${e.author}: ${e.text}`)
    .join("\n");
  return { rendered, entries };
}

// ── Output parsing ────────────────────────────────────────────────────

// Belt-and-braces: the prompt demands bare JSON, but fast models
// occasionally wrap output in a markdown fence anyway. Strip one if
// present. (Same guard as effort-routing.ts.)
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

function isConfidence(v: unknown): v is number {
  // Out-of-range or NaN confidences are REJECTED, never clamped — a
  // model emitting 1.5 is a model we shouldn't act on.
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

function toCandidate(v: unknown): KbCandidate | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.entry !== "string") return null;
  if (o.kind !== "correction" && o.kind !== "fact" && o.kind !== "decision") return null;
  if (!Array.isArray(o.evidence) || !o.evidence.every((i) => Number.isInteger(i))) return null;
  if (!isConfidence(o.confidence)) return null;
  return {
    entry: o.entry,
    kind: o.kind,
    evidence: o.evidence as number[],
    confidence: o.confidence,
  };
}

/**
 * Validate an already-parsed extractor envelope. Null only for a
 * malformed envelope (the whole payload is untrustworthy); individual
 * bad candidates are FILTERED so one hallucinated shape doesn't discard
 * valid siblings. Truncates to MAX_KB_CANDIDATES after filtering.
 */
function validateExtractorEnvelope(parsed: unknown): KbCandidate[] | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const candidates = (parsed as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates)) return null;
  return candidates
    .map(toCandidate)
    .filter((c): c is KbCandidate => c !== null)
    .slice(0, MAX_KB_CANDIDATES);
}

/**
 * Parse raw extractor output. Returns null ONLY for a malformed
 * envelope (unparseable JSON or a wrong top-level shape); per-candidate
 * problems filter that candidate and keep the rest. Pure function.
 */
export function parseExtractorOutput(raw: string): KbCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return null;
  }
  return validateExtractorEnvelope(parsed);
}

// ── Extractor call ────────────────────────────────────────────────────

export interface ExtractInput {
  /** Rendered transcript from buildExtractionTranscript. */
  transcript: string;
}

export interface ExtractDeps {
  /**
   * Injectable model call for tests. In prod defaults to a FAST_MODEL
   * call. The signal aborts when the extractor timeout fires so a slow
   * request doesn't keep running (and billing) after we've given up.
   */
  call?: (prompt: string, signal?: AbortSignal) => Promise<string>;
  /** Logger for kb_extraction_complete / kb_extraction_error events. */
  log?: LogFn;
}

// Internal sentinel so the catch block can distinguish our own timeout
// from a real API failure without string-matching error messages.
class ExtractorTimeoutError extends Error {
  constructor() {
    super(`kb extractor timed out after ${KB_EXTRACTOR_TIMEOUT_MS}ms`);
  }
}

/**
 * One fast-model extraction call. NEVER throws — every failure mode
 * (API error, sync throw from an injected call, timeout, malformed
 * JSON, invalid envelope) logs `kb_extraction_error` with a stable
 * reason and returns null. Success logs `kb_extraction_complete`.
 */
export async function extractKbCandidates(
  input: ExtractInput,
  deps: ExtractDeps = {},
): Promise<KbCandidate[] | null> {
  const log = deps.log ?? defaultLog;
  const call = deps.call ?? defaultCall;
  const start = Date.now();

  // Replacer FUNCTION, not a bare string — String.replace treats `$&`
  // and friends in a string replacement as substitution patterns, so a
  // transcript containing `$&` would garble the prompt.
  const prompt = KB_EXTRACTION_PROMPT.replace("<TRANSCRIPT>", () => input.transcript);

  let raw: string;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    raw = await Promise.race([
      // Promise.resolve().then(...) converts a synchronously-throwing
      // injected call into a rejection instead of an escaping throw.
      Promise.resolve().then(() => call(prompt, controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Abort the losing request too — Promise.race alone would let
          // the model call keep running after we've moved on.
          controller.abort();
          reject(new ExtractorTimeoutError());
        }, KB_EXTRACTOR_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    log("kb_extraction_error", {
      reason: err instanceof ExtractorTimeoutError ? "timeout" : "api_error",
      message: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
      model: FAST_MODEL,
    });
    return null;
  } finally {
    // Clear on the win path too — a live timer would hold the
    // serverless event loop open for the full 10s after a fast response.
    if (timer !== undefined) clearTimeout(timer);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch (err) {
    log("kb_extraction_error", {
      reason: "malformed_json",
      message: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
      model: FAST_MODEL,
    });
    return null;
  }

  const candidates = validateExtractorEnvelope(parsed);
  if (candidates === null) {
    log("kb_extraction_error", {
      reason: "invalid_shape",
      message: `unexpected extractor payload: ${JSON.stringify(parsed).slice(0, 200)}`,
      duration_ms: Date.now() - start,
      model: FAST_MODEL,
    });
    return null;
  }

  log("kb_extraction_complete", {
    candidateCount: candidates.length,
    duration_ms: Date.now() - start,
    model: FAST_MODEL,
  });
  return candidates;
}

async function defaultCall(prompt: string, signal?: AbortSignal): Promise<string> {
  const resp = await anthropic.messages.create(
    {
      model: FAST_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    },
    { signal },
  );
  return resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}
