import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import {
  verifySlackSignature,
  replyInThread,
  fetchMessage,
  getBotUserId,
  fetchThreadMessages,
  updateMessage,
  deleteMessage,
} from "@/lib/slack";
import { runAgent } from "@/lib/claude";
import { createIssue } from "@/lib/github";
import { parseProposalFromMessage } from "@/tools/create-issue";
import { storeQAContext, getQAContext, saveFeedback } from "@/lib/feedback";
import { formatReferences, rankReferences } from "@/lib/references";
import { getAllKnowledge } from "@/lib/knowledge";
import { buildCorrectionActions } from "@/lib/auto-correct";
import { buildThinkingMessage, THINKING_HEADER } from "@/lib/progress";
import { toSlackMrkdwn } from "@/lib/mrkdwn";
import { createRequestLogger } from "@/lib/logger";
import { getCachedTopics } from "@/lib/repo-index";
import { matchTopicsToQuestion, buildQuestionHints } from "@/lib/topic-match";
import { isAddressedToOtherUser, buildConversationHistory } from "@/lib/thread-filter";

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
  const rlog = createRequestLogger();

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
    rlog("signature_rejected");
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
    rlog("mention_received", { channel, user: event.user, question: userMessage.slice(0, 100) });

    // Ack now, process after response is sent (Vercel keeps fn alive)
    after(async () => {
      // Hoist thinkingTs so finally can always clean it up
      let thinkingTs: string | undefined;
      try {
        // Post thinking message and capture its ts for live updates
        thinkingTs = await replyInThread(
          channel, threadTs,
          THINKING_HEADER,
        );

        const cleanMessage = userMessage.replace(/<@[A-Z0-9]+>/g, "").trim();

        // Pre-match question against topic index for concrete file hints
        const topics = await getCachedTopics();
        const topicMatches = matchTopicsToQuestion(cleanMessage, topics);
        const augmentedMessage = buildQuestionHints(cleanMessage, topicMatches);
        if (topicMatches.length > 0) {
          rlog("topic_hints_injected", { topics: topicMatches.map((m) => m.topic), fileCount: topicMatches.reduce((s, m) => s + m.paths.length, 0) });
        }

        const result = await runAgent(augmentedMessage, async (toolName, input) => {
          if (thinkingTs) {
            await updateMessage(channel, thinkingTs, buildThinkingMessage(toolName, input));
          }
        });
        rlog("agent_complete", { rounds: result.references.length, hasProposal: !!result.issueProposal, refCount: result.references.length });

        // Update thinking message to "composing" before posting answer
        if (thinkingTs) {
          await updateMessage(channel, thinkingTs, buildThinkingMessage("composing", {}));
        }

        const text = toSlackMrkdwn(result.text);
        const rankedRefs = rankReferences(result.references, result.text);
        const refsFooter = formatReferences(rankedRefs);

        // Delete thinking message — the answer replaces it
        if (thinkingTs) {
          await deleteMessage(channel, thinkingTs);
          thinkingTs = undefined; // Mark as cleaned up
        }

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
          rlog("answer_posted", { channel, threadTs });
        } else {
          const replyTs = await replyInThread(channel, threadTs, text + refsFooter);
          rlog("answer_posted", { channel, threadTs });

          // Store Q&A context so 👍/👎 reactions can reference it
          if (replyTs) {
            await storeQAContext(channel, replyTs, {
              question: cleanMessage,
              answer: result.text.slice(0, 500),
              references: result.references.map((r) => r.label),
            });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        rlog("error", { flow: "mention", message: msg });
        await replyInThread(
          channel,
          threadTs,
          `Something went wrong while processing your request. Error: ${msg}`,
        );
      } finally {
        // Safety net: delete thinking message if it wasn't cleaned up
        if (thinkingTs) {
          await deleteMessage(channel, thinkingTs);
        }
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

    // Skip messages addressed to a specific non-bot user (e.g. "@vlad can you check?")
    if (isAddressedToOtherUser(event.text ?? "", botId)) {
      rlog("thread_skip_addressed_to_other", { channel: event.channel, threadTs: event.thread_ts });
      return NextResponse.json({ ok: true });
    }

    const channel: string = event.channel;
    const threadTs: string = event.thread_ts;
    const userMessage: string = event.text;
    rlog("thread_followup", { channel, threadTs });

    after(async () => {
      let thinkTs: string | undefined;
      try {
        // Check for pending correction (from a 👎 reaction)
        const { kv } = await import("@vercel/kv");
        const pendingKey = `pending-correction:${channel}:${threadTs}`;
        const pendingRaw = await kv.get<string>(pendingKey);
        if (pendingRaw) {
          // This reply is a correction — save directly to KB
          const pending = typeof pendingRaw === "string" ? JSON.parse(pendingRaw) : pendingRaw;
          const { saveKnowledgeEntry } = await import("@/lib/knowledge");

          await saveKnowledgeEntry(userMessage);

          // Save the negative feedback NOW with the actual correction text
          await saveFeedback({
            type: "negative",
            question: pending.question || "",
            detail: `Correction: "${userMessage.slice(0, 200)}"`,
            timestamp: new Date().toISOString().split("T")[0],
          });

          // Clear the pending state
          await kv.del(pendingKey);
          rlog("correction_saved", { entry: userMessage.slice(0, 100) });

          await replyInThread(
            channel,
            threadTs,
            `:white_check_mark: Saved to knowledge base: _"${userMessage.slice(0, 100)}"_`,
          );
          return;
        }

        // Fetch thread messages — used for both participation check and context
        const bid = botId || (await getBotUserId());
        const threadMessages = await fetchThreadMessages(channel, threadTs);
        const botInThread = bid ? threadMessages.some((m) => m.user === bid) : false;
        if (!bid || !botInThread) return;
        rlog("followup_agent_start", { channel, threadTs });

        thinkTs = await replyInThread(
          channel, threadTs,
          THINKING_HEADER,
        );

        const cleanMessage = userMessage.replace(/<@[A-Z0-9]+>/g, "").trim();

        // Build proper multi-turn conversation history from thread
        // (uses Anthropic's native message format, not string hacking)
        const history = buildConversationHistory(threadMessages, bid);

        // Pre-match for thread follow-ups too
        const followupTopics = await getCachedTopics();
        const followupMatches = matchTopicsToQuestion(cleanMessage, followupTopics);
        const followupMessage = buildQuestionHints(cleanMessage, followupMatches);

        const result = await runAgent(followupMessage, async (toolName, input) => {
          if (thinkTs) {
            await updateMessage(channel, thinkTs, buildThinkingMessage(toolName, input));
          }
        }, history);

        if (thinkTs) {
          await updateMessage(channel, thinkTs, buildThinkingMessage("composing", {}));
        }

        const text = toSlackMrkdwn(result.text);
        const rankedRefs = rankReferences(result.references, result.text);
        const refsFooter = formatReferences(rankedRefs);

        if (thinkTs) {
          await deleteMessage(channel, thinkTs);
          thinkTs = undefined; // Mark as cleaned up
        }

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
          const replyTs = await replyInThread(channel, threadTs, text + refsFooter);

          if (replyTs) {
            await storeQAContext(channel, replyTs, {
              question: cleanMessage,
              answer: result.text.slice(0, 500),
              references: result.references.map((r) => r.label),
            });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        rlog("error", { flow: "thread_followup", message: msg });
        await replyInThread(
          channel,
          threadTs,
          `Something went wrong while processing your request. Error: ${msg}`,
        );
      } finally {
        // Safety net: delete thinking message if it wasn't cleaned up
        if (thinkTs) {
          await deleteMessage(channel, thinkTs);
        }
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
    rlog("reaction_checkmark", { channel, messageTs });

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

        rlog("issue_created", { number: issue.number });

        // Reply in the same thread with the new issue link
        const threadTs = msg.thread_ts || messageTs;
        await replyInThread(
          channel,
          threadTs,
          `:white_check_mark: Created issue *#${issue.number}*: <${issue.url}|${issue.title}>`,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        rlog("error", { flow: "reaction_checkmark", message: errMsg });
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

  // ── Handle 👍 reaction → save positive feedback ─────────────────────
  if (event.type === "reaction_added" && event.reaction === "+1") {
    const item = event.item;
    if (item?.type !== "message") return NextResponse.json({ ok: true });

    const channel: string = item.channel;
    const messageTs: string = item.ts;
    rlog("reaction_thumbsup", { channel, messageTs });

    after(async () => {
      try {
        const botId = await getBotUserId();
        if (botId && event.user === botId) return;

        // Only act on bot messages
        const msg = await fetchMessage(channel, messageTs);
        if (!msg || msg.user !== botId) return;

        const context = await getQAContext(channel, messageTs);
        if (!context) return; // No Q&A context — probably not an answer message

        await saveFeedback({
          type: "positive",
          question: context.question,
          detail: `👍 for: "${context.question.slice(0, 80)}" — used: ${context.references.join(", ") || "general knowledge"}`,
          timestamp: new Date().toISOString().split("T")[0],
        });
        rlog("feedback_positive", { question: context.question.slice(0, 80) });

        // Silent acknowledgment — just add a checkmark reaction
        try {
          const { slack } = await import("@/lib/slack");
          await slack.reactions.add({ channel, name: "brain", timestamp: messageTs });
        } catch { /* already reacted or can't react — ignore */ }
      } catch (err) {
        rlog("error", { flow: "reaction_thumbsup", message: err instanceof Error ? err.message : String(err) });
      }
    });

    return NextResponse.json({ ok: true });
  }

  // ── Handle 👎 reaction → ask for correction, save negative feedback ─
  if (event.type === "reaction_added" && event.reaction === "-1") {
    const item = event.item;
    if (item?.type !== "message") return NextResponse.json({ ok: true });

    const channel: string = item.channel;
    const messageTs: string = item.ts;
    rlog("reaction_thumbsdown", { channel, messageTs });

    after(async () => {
      try {
        const botId = await getBotUserId();
        if (botId && event.user === botId) return;

        const msg = await fetchMessage(channel, messageTs);
        if (!msg || msg.user !== botId) return;

        const context = await getQAContext(channel, messageTs);
        if (!context) return;

        const threadTs = msg.thread_ts || messageTs;

        // Flag possibly related KB entries and docs (don't auto-remove)
        const kbEntries = await getAllKnowledge();
        const actions = buildCorrectionActions(context.references, kbEntries);
        rlog("feedback_negative", { kbFlagged: actions.kbEntriesToFlag.length, docsFlagged: actions.docsToProposeFix.length });

        const notes: string[] = [];

        if (actions.kbEntriesToFlag.length > 0) {
          notes.push("*Possibly related KB entries* (reply to confirm removal):");
          for (const entry of actions.kbEntriesToFlag) {
            notes.push(`  • _"${entry.entry}"_`);
          }
        }

        if (actions.docsToProposeFix.length > 0) {
          const docList = actions.docsToProposeFix.map((d) => `\`${d}\``).join(", ");
          notes.push(`*Docs referenced:* ${docList}`);
        }

        const flagText = notes.length > 0 ? `\n\n${notes.join("\n")}` : "";

        // Store pending correction state so the next reply is saved as a KB correction
        const pendingKey = `pending-correction:${channel}:${threadTs}`;
        const { kv } = await import("@vercel/kv");
        await kv.set(pendingKey, JSON.stringify({
          question: context.question,
          references: context.references,
          flaggedKB: actions.kbEntriesToFlag.map((e) => e.entry),
        }), { ex: 86400 }); // 24h TTL

        await replyInThread(
          channel,
          threadTs,
          `:thinking_face: Thanks for the feedback.${flagText}\n\nWhat was wrong? Reply here and I'll save the correction.`,
        );
      } catch (err) {
        rlog("error", { flow: "reaction_thumbsdown", message: err instanceof Error ? err.message : String(err) });
      }
    });

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
