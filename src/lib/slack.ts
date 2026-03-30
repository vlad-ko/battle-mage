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

// ── Thread reply helper ───────────────────────────────────────────────
export async function replyInThread(
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  await slack.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text,
  });
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

// ── Check if bot is participating in a thread ────────────────────────
export async function isBotInThread(
  channel: string,
  threadTs: string,
  botUserId: string,
): Promise<boolean> {
  try {
    const result = await slack.conversations.replies({
      channel,
      ts: threadTs,
      limit: 50,
    });
    return result.messages?.some((m) => m.user === botUserId) ?? false;
  } catch {
    return false;
  }
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
