import crypto from "crypto";
import { WebClient } from "@slack/web-api";

// ── Slack client ──────────────────────────────────────────────────────
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
export { slack };

// ── Signature verification (HMAC-SHA256) ──────────────────────────────
// Protects the webhook endpoint from forged requests.
// See: https://api.slack.com/authentication/verifying-requests-from-slack

const TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret || !timestamp || !signature) return false;

  // Reject stale timestamps to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > TIMESTAMP_TOLERANCE_SECONDS) {
    return false;
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto
    .createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");

  const expected = `v0=${hmac}`;

  // Constant-time comparison to prevent timing attacks
  const expectedBuf = Buffer.from(expected, "utf8");
  const signatureBuf = Buffer.from(signature, "utf8");

  if (expectedBuf.length !== signatureBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

// ── Slack message length guard (safety net) ──────────────────────────
// Slack's `chat.postMessage` / `chat.update` cap `text` at 40,000 —
// measured in BYTES, not characters (the docs say "characters" but
// empirical behavior on msg_too_long rejects aligns with byte count).
// Unicode content blows this up fast: em-dash `—` = 3 bytes, emoji = 4,
// divider `─` = 3. A 39K-char answer with moderate unicode density
// easily crosses 42-45K BYTES, which Slack refuses.
//
// First shipped a char-based cap in #110 — still saw msg_too_long on
// unicode-heavy answers. Moving to byte-based cap here. See #108.
//
// PRIMARY fix for oversized replies still lives in the prompt
// (ANSWER_BUDGET_CHARS in claude.ts — 20K char target). This function
// is a last-line-of-defense safety net; when it fires, that's a signal
// the prompt guidance needs tuning for a class of question.
export const SLACK_MESSAGE_BYTE_CAP = 36_000;

const TRUNCATION_NOTE =
  "\n\n_…(answer cut off to fit Slack's message size limit — ask a narrower follow-up for detail on any specific area.)_";

const textEncoder = new TextEncoder();
// `fatal: false` so a mid-multi-byte-char cut at the budget boundary is
// gracefully replaced with U+FFFD rather than throwing. `ignoreBOM: true`
// because Slack messages never need a BOM.
const textDecoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/**
 * Cap a Slack message body at `SLACK_MESSAGE_BYTE_CAP` BYTES (UTF-8).
 * Short messages pass through unchanged; oversized ones are sliced at
 * a byte-aligned boundary with the partial multi-byte sequence at the
 * cut handled by TextDecoder's replacement behavior, then the
 * truncation note is appended. Result's byte length is guaranteed
 * ≤ SLACK_MESSAGE_BYTE_CAP (the note's bytes are reserved in the
 * initial budget).
 *
 * Pure function; no I/O.
 */
export function capSlackMessage(text: string): string {
  const textBytes = textEncoder.encode(text);
  if (textBytes.length <= SLACK_MESSAGE_BYTE_CAP) return text;

  const noteBytes = textEncoder.encode(TRUNCATION_NOTE).length;
  // When the slice lands inside a multi-byte char, TextDecoder substitutes
  // U+FFFD (3 UTF-8 bytes) for the partial sequence. That can make the
  // re-encoded result 2–3 bytes larger than the byte slice itself, so we
  // pre-reserve 3 bytes for that overhead.
  const REPLACEMENT_OVERHEAD = 3;
  const budget = SLACK_MESSAGE_BYTE_CAP - noteBytes - REPLACEMENT_OVERHEAD;
  let head = textDecoder.decode(textBytes.slice(0, budget));
  // Defensive trim: in case a pathological input still spills past the cap
  // (e.g. grapheme clusters across multiple code points), shave chars until
  // we fit. Finite loop bounded by head.length.
  while (textEncoder.encode(head + TRUNCATION_NOTE).length > SLACK_MESSAGE_BYTE_CAP) {
    head = head.slice(0, -1);
  }
  return head + TRUNCATION_NOTE;
}

// ── Thread reply helper ───────────────────────────────────────────────
export async function replyInThread(
  channel: string,
  threadTs: string,
  text: string,
): Promise<string | undefined> {
  const result = await slack.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: capSlackMessage(text),
  });
  return result.ts; // message timestamp — used to track Q&A context for feedback
}

// ── Update a message in place ─────────────────────────────────────────
export async function updateMessage(
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  await slack.chat.update({ channel, ts, text: capSlackMessage(text) });
}

// ── Delete a message ──────────────────────────────────────────────────
export async function deleteMessage(
  channel: string,
  ts: string,
): Promise<void> {
  try {
    await slack.chat.delete({ channel, ts });
  } catch {
    // Best-effort — message may already be deleted or bot may lack permission
  }
}

// ── Fetch a single message by channel + ts ───────────────────────────
// Works for both thread parents and threaded replies.
// Uses conversations.replies which accepts any message ts in a thread.
export async function fetchMessage(
  channel: string,
  ts: string,
): Promise<{ text: string; user?: string; thread_ts?: string } | null> {
  try {
    const result = await slack.conversations.replies({
      channel,
      ts,
      inclusive: true,
      limit: 1,
    });
    const msg = result.messages?.[0];
    if (!msg) return null;
    return { text: msg.text ?? "", user: msg.user, thread_ts: msg.thread_ts };
  } catch {
    return null;
  }
}

// ── Fetch thread messages (used for context and participation check) ──
export interface ThreadMessage {
  user?: string;
  text?: string;
  bot_id?: string;
}

export async function fetchThreadMessages(
  channel: string,
  threadTs: string,
): Promise<ThreadMessage[]> {
  try {
    const result = await slack.conversations.replies({
      channel,
      ts: threadTs,
      limit: 50,
    });
    return (result.messages ?? []).map((m) => ({
      user: m.user,
      text: m.text ?? "",
      bot_id: m.bot_id,
    }));
  } catch {
    return [];
  }
}

// ── Check if bot is participating in a thread ────────────────────────
export async function isBotInThread(
  channel: string,
  threadTs: string,
  botUserId: string,
): Promise<boolean> {
  const messages = await fetchThreadMessages(channel, threadTs);
  return messages.some((m) => m.user === botUserId);
}

// ── Get bot's own user ID (cached per cold start) ────────────────────
let cachedBotUserId: string | undefined;

export async function getBotUserId(): Promise<string | undefined> {
  if (cachedBotUserId) return cachedBotUserId;
  try {
    const result = await slack.auth.test();
    cachedBotUserId = result.user_id ?? undefined;
    return cachedBotUserId;
  } catch {
    return undefined;
  }
}
