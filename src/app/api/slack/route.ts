import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import {
  verifySlackSignature,
  replyInThread,
  fetchMessage,
  getBotUserId,
  isBotInThread,
} from "@/lib/slack";
import { runAgent } from "@/lib/claude";
import { createIssue } from "@/lib/github";
import { parseProposalFromMessage } from "@/tools/create-issue";

import type { Reference } from "@/tools";

// ── Convert GitHub-style markdown to Slack mrkdwn ────────────────────
function toSlackMrkdwn(text: string): string {
  return text
    // ## Heading → *Heading* (bold line)
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    // **bold** → *bold*
    .replace(/\*\*(.+?)\*\*/g, "*$1*");
}

// ── Format references as a Slack footer ──────────────────────────────
function formatReferences(refs: Reference[]): string {
  if (refs.length === 0) return "";
  const links = refs.map((r) => `<${r.url}|${r.label}>`).join("  ·  ");
  return `\n\n───\n:link: ${links}`;
}

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
        // Immediate feedback so the user knows the bot is working
        await replyInThread(channel, threadTs, ":brain: Battle Mage is thinking... (this may take a minute, go grab some tea)");

        const cleanMessage = userMessage.replace(/<@[A-Z0-9]+>/g, "").trim();
        const result = await runAgent(cleanMessage);

        const text = toSlackMrkdwn(result.text);
        const refsFooter = formatReferences(result.references);

        if (result.issueProposal) {
          const proposal = result.issueProposal;
          const labelsText = proposal.labels?.length
            ? `\nLabels: ${proposal.labels.join(", ")}`
            : "";

          await replyInThread(
            channel,
            threadTs,
            [
              text,
              "",
              "───────────────────",
              `*Proposed Issue:* ${proposal.title}${labelsText}`,
              "",
              proposal.body,
              "",
              "React with :white_check_mark: to create this issue, or ignore to cancel.",
            ].join("\n") + refsFooter,
          );
        } else {
          await replyInThread(channel, threadTs, text + refsFooter);
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

  // ── Handle thread follow-ups (no re-mention needed) ─────────────────
  if (
    event.type === "message" &&
    !event.subtype &&
    event.thread_ts &&
    event.thread_ts !== event.ts // it's a reply, not the parent
  ) {
    // Skip messages that @mention the bot — already handled by app_mention
    const botId = await getBotUserId();
    if (botId && event.text?.includes(`<@${botId}>`)) {
      return NextResponse.json({ ok: true });
    }

    const channel: string = event.channel;
    const threadTs: string = event.thread_ts;
    const userMessage: string = event.text;

    after(async () => {
      try {
        // Only respond if the bot is already in this thread
        const bid = botId || (await getBotUserId());
        if (!bid || !(await isBotInThread(channel, threadTs, bid))) return;

        await replyInThread(channel, threadTs, ":brain: Battle Mage is thinking... (this may take a minute, go grab some tea)");

        const cleanMessage = userMessage.replace(/<@[A-Z0-9]+>/g, "").trim();
        const result = await runAgent(cleanMessage);
        const text = toSlackMrkdwn(result.text);
        const refsFooter = formatReferences(result.references);

        if (result.issueProposal) {
          const proposal = result.issueProposal;
          const labelsText = proposal.labels?.length
            ? `\nLabels: ${proposal.labels.join(", ")}`
            : "";

          await replyInThread(
            channel,
            threadTs,
            [
              text,
              "",
              "───────────────────",
              `*Proposed Issue:* ${proposal.title}${labelsText}`,
              "",
              proposal.body,
              "",
              "React with :white_check_mark: to create this issue, or ignore to cancel.",
            ].join("\n") + refsFooter,
          );
        } else {
          await replyInThread(channel, threadTs, text + refsFooter);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error("Battle Mage thread follow-up error:", msg);
        await replyInThread(
          channel,
          threadTs,
          `Something went wrong while processing your request. Error: ${msg}`,
        );
      }
    });

    return NextResponse.json({ ok: true });
  }

  // ── Handle ✅ reaction on proposal messages → create the issue ─────
  if (event.type === "reaction_added" && event.reaction === "white_check_mark") {
    const item = event.item;
    if (item?.type !== "message") return NextResponse.json({ ok: true });

    const channel: string = item.channel;
    const messageTs: string = item.ts;
    const reactingUser: string = event.user;

    after(async () => {
      try {
        // Ignore reactions from the bot itself
        const botId = await getBotUserId();
        if (botId && reactingUser === botId) return;

        // Fetch the message that was reacted to
        const msg = await fetchMessage(channel, messageTs);
        if (!msg) return;

        // Only act on our own messages (proposals posted by the bot)
        if (msg.user !== botId) return;

        // Parse the proposal from the message text
        const proposal = parseProposalFromMessage(msg.text);
        if (!proposal) return; // Not a proposal message — ignore

        // Create the issue on GitHub
        const issue = await createIssue(
          proposal.title,
          proposal.body,
          proposal.labels,
        );

        // Reply in the same thread with the new issue link
        const threadTs = msg.thread_ts || messageTs;
        await replyInThread(
          channel,
          threadTs,
          `:white_check_mark: Created issue *#${issue.number}*: <${issue.url}|${issue.title}>`,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        console.error("Battle Mage reaction handler error:", errMsg);
        // Best-effort reply — use thread_ts if available
        try {
          const msg = await fetchMessage(channel, messageTs);
          const threadTs = msg?.thread_ts || messageTs;
          await replyInThread(
            channel,
            threadTs,
            `Failed to create issue: ${errMsg}`,
          );
        } catch {
          // Can't reply — just log
        }
      }
    });

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
