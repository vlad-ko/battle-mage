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

// ── Slack message length guard ────────────────────────────────────────
// Slack's `chat.postMessage` / `chat.update` cap `text` at 40,000 chars.
// Exceeding this throws `An API error occurred: msg_too_long` — the
// error that haunted us through #100, mis-attributed to Anthropic's
// context-window limit. Actual root cause: Slack's message cap. We leave
// ~500 chars of headroom under the hard limit so the truncation note
// itself can't push us over.
export const SLACK_MESSAGE_HARD_CAP = 39_500;

const TRUNCATION_NOTE =
  "\n\n_…(response truncated — exceeded Slack's 40K-character message limit. Ask a narrower follow-up for full detail.)_";

/**
 * Cap a message body at Slack's max length. Passes short messages
 * through unchanged; for oversized messages, takes the first N chars
 * (leaving room for the note) and appends a truncation note so the
 * user knows they got a partial response. Pure function; no I/O.
 */
export function capSlackMessage(text: string): string {
  if (text.length <= SLACK_MESSAGE_HARD_CAP) return text;
  const budget = SLACK_MESSAGE_HARD_CAP - TRUNCATION_NOTE.length;
  return text.slice(0, budget) + TRUNCATION_NOTE;
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
