import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { verifySlackSignature, replyInThread } from "@/lib/slack";
import { runAgent } from "@/lib/claude";

/**
 * Slack Events API webhook handler.
 *
 * Handles:
 * - URL verification challenge (Slack app setup)
 * - app_mention events (@bm invocation)
 *
 * Slack requires a 200 OK within 3 seconds. We ack immediately
 * and process the AI + GitHub calls asynchronously via after().
 */
export async function POST(request: NextRequest) {
  // Read raw body for signature verification, then parse
  const rawBody = await request.text();
  const body = JSON.parse(rawBody);

  // ── Slack URL verification challenge (one-time during app setup) ──
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  // ── Verify Slack signature (HMAC-SHA256) ──────────────────────────
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");

  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  // ── Handle events ─────────────────────────────────────────────────
  const event = body.event;

  // Ignore bot messages to prevent loops
  if (!event || event.bot_id || event.subtype === "bot_message") {
    return NextResponse.json({ ok: true });
  }

  // Ignore Slack retries (we already acked)
  if (request.headers.get("x-slack-retry-num")) {
    return NextResponse.json({ ok: true });
  }

  if (event.type === "app_mention") {
    const channel: string = event.channel;
    const threadTs: string = event.thread_ts || event.ts;
    const userMessage: string = event.text;

    // Ack now, process after response is sent (Vercel keeps fn alive)
    after(async () => {
      try {
        const cleanMessage = userMessage.replace(/<@[A-Z0-9]+>/g, "").trim();
        const result = await runAgent(cleanMessage);

        if (result.issueProposal) {
          const proposal = result.issueProposal;
          const labelsText = proposal.labels?.length
            ? `\nLabels: ${proposal.labels.join(", ")}`
            : "";

          await replyInThread(
            channel,
            threadTs,
            [
              result.text,
              "",
              "───────────────────",
              `*Proposed Issue:* ${proposal.title}${labelsText}`,
              "",
              proposal.body,
              "",
              '👆 Reply *"yes"* or *"create it"* to confirm, or *"no"* to cancel.',
            ].join("\n"),
          );
        } else {
          await replyInThread(channel, threadTs, result.text);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error("Battle Mage error:", msg);
        await replyInThread(
          channel,
          threadTs,
          `Something went wrong while processing your request. Error: ${msg}`,
        );
      }
    });

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
