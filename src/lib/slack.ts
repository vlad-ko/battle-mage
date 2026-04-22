import crypto from "crypto";
import { WebClient } from "@slack/web-api";
import { splitSlackReplyText } from "./split-reply";

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

// ── Slack message length guard (fail-loud boundary) ──────────────────
// Slack rejects `chat.postMessage` / `chat.update` calls whose `text`
// exceeds 40,000 with `msg_too_long`. The primary defense against that
// is the splitter (src/lib/split-reply.ts) which chops long answers
// into multiple thread posts, each well under the limit. This guard
// is the last line of defense: if anything ever reaches the wire
// oversized, we throw so Sentry gets a loud stack with our own frame
// (rather than a minified Slack SDK frame) and the user sees a clear
// error rather than silently losing part of their answer.
//
// See #112 for the architectural rationale.
export const SLACK_MESSAGE_CHAR_LIMIT = 40_000;

export class SlackMessageOversizeError extends Error {
  constructor(action: string, length: number) {
    super(
      `${action} text is ${length} chars, exceeds Slack's ${SLACK_MESSAGE_CHAR_LIMIT}-char limit — splitter bug`,
    );
    this.name = "SlackMessageOversizeError";
  }
}

/**
 * Throws SlackMessageOversizeError if `text` would trip Slack's
 * msg_too_long. The splitter is expected to keep us well under this
 * bound — anything reaching the guard oversized is a bug worth surfacing.
 *
 * Pure function; no I/O.
 */
export function requireSlackMessageText(text: string, action: string): string {
  if (text.length > SLACK_MESSAGE_CHAR_LIMIT) {
    throw new SlackMessageOversizeError(action, text.length);
  }
  return text;
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
    text: requireSlackMessageText(text, "chat.postMessage"),
  });
  return result.ts; // message timestamp — used to track Q&A context for feedback
}

// ── Update a message in place ─────────────────────────────────────────
export async function updateMessage(
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  await slack.chat.update({
    channel,
    ts,
    text: requireSlackMessageText(text, "chat.update"),
  });
}

// ── Multi-post delivery (splits long bodies into N thread replies) ───
// Primary entry point for any final-answer post. Splits `text` into
// chunks via `splitSlackReplyText`; edits the thinking message with
// chunk 0 (if `thinkingTs` given) or posts it fresh, then posts the
// remaining chunks as new thread replies. Returns the TS of chunk 0
// (for Q&A-context storage).
//
// Short answers (the common case) produce one chunk → same UX as before.
// Long answers produce 2-4 chunks → still one logical answer, split at
// paragraph boundaries with a "[continued ↓]" hint on intermediate posts.
export interface PostReplyInChunksInput {
  channel: string;
  threadTs: string;
  thinkingTs?: string;
  text: string;
}

export interface PostReplyInChunksResult {
  // TS of chunk 0 — used as the stable "answer id" across the whole split.
  firstTs: string | undefined;
  // TS of every posted chunk in order (0..N-1). Callers store Q&A
  // context against each TS so a reaction on any chunk resolves to the
  // same answer (see #114). Empty when chunks === 0.
  allTs: string[];
  // Number of chunks posted. 0 if the text was empty after trim.
  chunks: number;
}

export async function postReplyInChunks(
  input: PostReplyInChunksInput,
): Promise<PostReplyInChunksResult> {
  const chunks = splitSlackReplyText(input.text);
  if (chunks.length === 0) {
    return { firstTs: undefined, allTs: [], chunks: 0 };
  }

  const allTs: string[] = [];

  const first = chunks[0] ?? "";
  let firstTs: string | undefined;
  if (input.thinkingTs) {
    // Edit the thinking message in place — it becomes the first chunk.
    await updateMessage(input.channel, input.thinkingTs, first);
    firstTs = input.thinkingTs;
  } else {
    firstTs = await replyInThread(input.channel, input.threadTs, first);
  }
  if (firstTs) allTs.push(firstTs);

  // Remaining chunks post as fresh thread replies in order.
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i] ?? "";
    const ts = await replyInThread(input.channel, input.threadTs, chunk);
    if (ts) allTs.push(ts);
  }

  return { firstTs, allTs, chunks: chunks.length };
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
