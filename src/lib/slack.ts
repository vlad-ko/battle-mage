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
