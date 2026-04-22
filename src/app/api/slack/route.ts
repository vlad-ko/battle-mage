import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  verifySlackSignature,
  replyInThread,
  fetchMessage,
  getBotUserId,
  fetchThreadMessages,
  updateMessage,
  deleteMessage,
  postReplyInChunks,
} from "@/lib/slack";
import { runAgent } from "@/lib/claude";
import { createIssue } from "@/lib/github";
import { parseProposalFromMessage } from "@/tools/create-issue";
import { storeQAContext, getQAContext, saveFeedback, deriveReferenceTypes } from "@/lib/feedback";
import { formatReferences, rankReferences } from "@/lib/references";
import { getAllKnowledge } from "@/lib/knowledge";
import { buildCorrectionActions } from "@/lib/auto-correct";
import { toSlackMrkdwn } from "@/lib/mrkdwn";
import { buildThinkingMessage, THINKING_HEADER } from "@/lib/progress";
import { createThrottledUpdater } from "@/lib/slack-throttle";
import { formatReplyFooter, isReplyFooterEnabled } from "@/lib/reply-footer";
import {
  extractParticipantIds,
  resolveParticipants,
  type Participant,
} from "@/lib/slack-users";
import { createRequestLogger, flushLogs } from "@/lib/logger";
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

  // Ignore bot messages and echo events (message_changed, message_deleted, etc.)
  // These fire when BM updates its own thinking messages — harmless but noisy
  if (!event || event.bot_id || event.subtype) {
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
    rlog("mention_start", { channel, user: event.user, thread: !!event.thread_ts, question: userMessage.slice(0, 100) });

    // Ack now, process after response is sent (Vercel keeps fn alive)
    // Logs inside after() need an explicit event-loop yield (flushLogs) to
    // reach Vercel's log drain — see #90. Every after() block below ends
    // with `await flushLogs(rlog, "<flow>")` inside its finally clause.
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

        // Thread participants for #80: resolve user IDs to display names
        // so the agent can @-mention correctly. Populated for BOTH fresh
        // mentions (participants = invoking user + anyone they mentioned)
        // and thread follow-ups (all thread authors + anyone mentioned).
        let mentionHistory: { role: "user" | "assistant"; content: string }[] | undefined;
        let mentionParticipants: Participant[] | undefined;
        const botId = await getBotUserId();
        if (event.thread_ts) {
          const threadMsgs = await fetchThreadMessages(channel, threadTs);
          if (botId) {
            mentionHistory = buildConversationHistory(threadMsgs, botId);
          }
          const ids = extractParticipantIds(threadMsgs, botId);
          if (ids.length > 0) {
            mentionParticipants = await resolveParticipants(ids);
          }
        } else {
          // Fresh top-level mention — the only participant signal is the
          // invoking user + anyone they mentioned in the message body.
          const ids = extractParticipantIds(
            [{ user: event.user, text: userMessage }],
            botId,
          );
          if (ids.length > 0) {
            mentionParticipants = await resolveParticipants(ids);
          }
        }

        // Pre-match question against topic index for concrete file hints
        const topics = await getCachedTopics();
        const topicMatches = matchTopicsToQuestion(cleanMessage, topics);
        const augmentedMessage = buildQuestionHints(cleanMessage, topicMatches);
        if (topicMatches.length > 0) {
          rlog("topic_hints_injected", { topics: topicMatches.map((m) => m.topic), fileCount: topicMatches.reduce((s, m) => s + m.paths.length, 0) });
        }

        // Tool-progress updater. Per #110 review: the streaming flood
        // from #109 was character-level text deltas, NOT tool-progress
        // messages. Tool progress at ~1 call per tool round (debounced
        // to coalesce parallel bursts) is 5-7 calls per turn — well
        // under Slack's 30/min Tier 2 limit and genuinely informative
        // for the user. Re-introducing it WITHOUT streaming.
        const progressThrottle = createThrottledUpdater(async (text) => {
          if (thinkingTs) {
            await updateMessage(channel, thinkingTs, text);
          }
        }, 1200);

        const result = await runAgent(
          augmentedMessage,
          mentionHistory,
          rlog,
          mentionParticipants,
          (toolName, input) => {
            progressThrottle.update(buildThinkingMessage(toolName, input));
          },
        );
        // Drain any pending progress update before the final write so a
        // stale progress message can't land on top of the final answer.
        await progressThrottle.flush();
        // `agent_complete` is already emitted by runAgent with rounds,
        // token usage, and cache metrics — don't duplicate at route level.

        const text = toSlackMrkdwn(result.text);
        const rankedRefs = rankReferences(result.references, result.text);
        const refsFooter = formatReferences(rankedRefs);
        // Optional compact telemetry footer (#79). Disabled by default;
        // enable with BM_REPLY_FOOTER=1 in the Vercel env.
        const replyFooter = isReplyFooterEnabled(process.env)
          ? formatReplyFooter(result.metrics, rlog.requestId)
          : "";

        if (result.issueProposal) {
          const proposal = result.issueProposal;
          const labelsText = proposal.labels?.length
            ? `\nLabels: ${proposal.labels.join(", ")}`
            : "";

          const finalBody = [
            text,
            "",
            "───────────────────",
            `*Proposed Issue:* ${proposal.title}${labelsText}`,
            "",
            proposal.body,
            "",
            "React with :white_check_mark: to create this issue, or ignore to cancel.",
          ].join("\n") + refsFooter + replyFooter;

          const posted = await postReplyInChunks({
            channel,
            threadTs,
            thinkingTs,
            text: finalBody,
          });
          // Only mark as finalized when we actually posted. A 0-chunk
          // result (empty body) falls through to the finally cleanup.
          if (posted.chunks > 0) thinkingTs = undefined;
          rlog("answer_posted", { channel, threadTs, chunks: posted.chunks, kind: "proposal" });
        } else {
          const finalBody = text + refsFooter + replyFooter;
          const posted = await postReplyInChunks({
            channel,
            threadTs,
            thinkingTs,
            text: finalBody,
          });
          if (posted.chunks > 0) thinkingTs = undefined;
          rlog("answer_posted", { channel, threadTs, chunks: posted.chunks });

          // Store Q&A context for EVERY chunk ts (see #114). Reactions
          // on any chunk resolve to the same question/answer pair.
          if (posted.firstTs && posted.allTs.length > 0) {
            const postedAt = Date.now();
            const referenceTypes = deriveReferenceTypes(result.references);
            await Promise.all(
              posted.allTs.map((ts, chunkIndex) =>
                storeQAContext(channel, ts, {
                  question: cleanMessage,
                  answer: result.text.slice(0, 500),
                  references: result.references.map((r) => r.label),
                  answerTs: posted.firstTs!,
                  chunkIndex,
                  chunkCount: posted.chunks,
                  postedAt,
                  referenceTypes,
                }),
              ),
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        rlog("error", { flow: "mention", message: msg });
        // Also capture as a Sentry Issue so the stack trace surfaces
        // in the dashboard — `rlog` alone produces a Log entry without
        // a stack, which is how #100 stayed a mystery (we knew the
        // error message but not what line in the after() body threw it).
        Sentry.captureException(err, { tags: { flow: "mention" } });
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
        // Yield so Vercel captures the after() block's logs — see #90.
        await flushLogs(rlog, "mention");
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
    rlog("thread_followup_start", { channel, threadTs, user: event.user, question: userMessage.slice(0, 100) });

    after(async () => {
      let thinkTs: string | undefined;
      try {
        // Check for pending correction (from a 👎 reaction)
        const { kv } = await import("@/lib/kv");
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
          // Close the 👎 → correction funnel with latency from the
          // moment 👎 was registered. `pendingAt` was added to the KV
          // record when the pending state was created (see reaction_thumbsdown
          // handler); fall back to 0 for records written before that.
          const pendingAt: number = typeof pending.pendingAt === "number" ? pending.pendingAt : 0;
          rlog("correction_saved", {
            channel,
            threadTs,
            answerTs: pending.answerTs ?? null,
            correctionLength: userMessage.length,
            timeSincePendingMs: pendingAt > 0 ? Date.now() - pendingAt : null,
            flaggedKBCount: Array.isArray(pending.flaggedKB) ? pending.flaggedKB.length : 0,
            correctionSample: userMessage.slice(0, 100),
          });

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

        // Thread participants for #80 — resolve IDs now so the agent can
        // @-mention teammates in its answer.
        const followupParticipantIds = extractParticipantIds(threadMessages, bid);
        const followupParticipants = followupParticipantIds.length > 0
          ? await resolveParticipants(followupParticipantIds)
          : undefined;

        // Pre-match for thread follow-ups too
        const followupTopics = await getCachedTopics();
        const followupMatches = matchTopicsToQuestion(cleanMessage, followupTopics);
        const followupMessage = buildQuestionHints(cleanMessage, followupMatches);

        // Mirror of the mention-flow progress updater — see comment
        // there + #110 for rationale.
        const followupProgress = createThrottledUpdater(async (text) => {
          if (thinkTs) {
            await updateMessage(channel, thinkTs, text);
          }
        }, 1200);

        const result = await runAgent(
          followupMessage,
          history,
          rlog,
          followupParticipants,
          (toolName, input) => {
            followupProgress.update(buildThinkingMessage(toolName, input));
          },
        );
        await followupProgress.flush();

        const text = toSlackMrkdwn(result.text);
        const rankedRefs = rankReferences(result.references, result.text);
        const refsFooter = formatReferences(rankedRefs);
        // Optional compact telemetry footer (#79) — mirrors the mention flow.
        const replyFooter = isReplyFooterEnabled(process.env)
          ? formatReplyFooter(result.metrics, rlog.requestId)
          : "";

        if (result.issueProposal) {
          const proposal = result.issueProposal;
          const labelsText = proposal.labels?.length
            ? `\nLabels: ${proposal.labels.join(", ")}`
            : "";

          const finalBody = [
            text,
            "",
            "───────────────────",
            `*Proposed Issue:* ${proposal.title}${labelsText}`,
            "",
            proposal.body,
            "",
            "React with :white_check_mark: to create this issue, or ignore to cancel.",
          ].join("\n") + refsFooter + replyFooter;

          const posted = await postReplyInChunks({
            channel,
            threadTs,
            thinkingTs: thinkTs,
            text: finalBody,
          });
          if (posted.chunks > 0) thinkTs = undefined;
          rlog("answer_posted", { channel, threadTs, chunks: posted.chunks, kind: "proposal" });
        } else {
          const finalBody = text + refsFooter + replyFooter;
          const posted = await postReplyInChunks({
            channel,
            threadTs,
            thinkingTs: thinkTs,
            text: finalBody,
          });
          if (posted.chunks > 0) thinkTs = undefined;
          rlog("answer_posted", { channel, threadTs, chunks: posted.chunks });

          if (posted.firstTs && posted.allTs.length > 0) {
            const postedAt = Date.now();
            const referenceTypes = deriveReferenceTypes(result.references);
            await Promise.all(
              posted.allTs.map((ts, chunkIndex) =>
                storeQAContext(channel, ts, {
                  question: cleanMessage,
                  answer: result.text.slice(0, 500),
                  references: result.references.map((r) => r.label),
                  answerTs: posted.firstTs!,
                  chunkIndex,
                  chunkCount: posted.chunks,
                  postedAt,
                  referenceTypes,
                }),
              ),
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        rlog("error", { flow: "thread_followup", message: msg });
        Sentry.captureException(err, { tags: { flow: "thread_followup" } });
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
        await flushLogs(rlog, "thread_followup");
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
        Sentry.captureException(err, { tags: { flow: "reaction_checkmark" } });
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
      } finally {
        await flushLogs(rlog, "reaction_checkmark");
      }
    });

    return NextResponse.json({ ok: true });
  }

  // ── Handle 👍 reaction → save positive feedback ─────────────────────
  if (event.type === "reaction_added" && event.reaction === "+1") {
    const item = event.item;
    const channel: string = item?.channel;
    const messageTs: string = item?.ts;
    rlog("reaction_received", {
      reaction: "+1",
      reactingUser: event.user,
      targetTs: messageTs,
      channel,
    });
    if (item?.type !== "message") {
      rlog("reaction_skipped", {
        reaction: "+1",
        reason: "non_message_item",
        targetTs: messageTs,
        channel,
      });
      return NextResponse.json({ ok: true });
    }

    after(async () => {
      try {
        const botId = await getBotUserId();
        if (botId && event.user === botId) {
          rlog("reaction_skipped", { reaction: "+1", reason: "bot_own_reaction", targetTs: messageTs, channel });
          return;
        }

        const msg = await fetchMessage(channel, messageTs);
        if (!msg || msg.user !== botId) {
          rlog("reaction_skipped", { reaction: "+1", reason: "target_not_bot_message", targetTs: messageTs, channel });
          return;
        }

        const context = await getQAContext(channel, messageTs);
        if (!context) {
          rlog("reaction_skipped", { reaction: "+1", reason: "no_qa_context", targetTs: messageTs, channel });
          return;
        }

        await saveFeedback({
          type: "positive",
          question: context.question,
          detail: `👍 for: "${context.question.slice(0, 80)}" — used: ${context.references.join(", ") || "general knowledge"}`,
          timestamp: new Date().toISOString().split("T")[0],
        });
        rlog("feedback_saved", {
          type: "positive",
          answerTs: context.answerTs,
          chunkIndex: context.chunkIndex,
          chunkCount: context.chunkCount,
          latencyMs: Date.now() - context.postedAt,
          referenceCount: context.references.length,
          referenceTypes: context.referenceTypes,
          questionLength: context.question.length,
          answerLength: context.answer.length,
          questionSample: context.question.slice(0, 80),
        });

        // Reaction ack — emit success/failure so "already_reacted" and
        // permission errors are no longer silent.
        try {
          const { slack } = await import("@/lib/slack");
          await slack.reactions.add({ channel, name: "brain", timestamp: messageTs });
          rlog("feedback_ack_added", { reactionName: "brain", chunkTs: messageTs });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // Slack returns specific error codes via @slack/web-api — bucket
          // them for metric-friendliness.
          const reason = errMsg.includes("already_reacted")
            ? "already_reacted"
            : errMsg.includes("not_in_channel") || errMsg.includes("missing_scope")
            ? "permission_denied"
            : "unknown";
          rlog("feedback_ack_failed", { reason, chunkTs: messageTs, errMsg: errMsg.slice(0, 120) });
        }
      } catch (err) {
        rlog("error", { flow: "reaction_thumbsup", message: err instanceof Error ? err.message : String(err) });
        Sentry.captureException(err, { tags: { flow: "reaction_thumbsup" } });
      } finally {
        await flushLogs(rlog, "reaction_thumbsup");
      }
    });

    return NextResponse.json({ ok: true });
  }

  // ── Handle 👎 reaction → ask for correction, save negative feedback ─
  if (event.type === "reaction_added" && event.reaction === "-1") {
    const item = event.item;
    const channel: string = item?.channel;
    const messageTs: string = item?.ts;
    rlog("reaction_received", {
      reaction: "-1",
      reactingUser: event.user,
      targetTs: messageTs,
      channel,
    });
    if (item?.type !== "message") {
      rlog("reaction_skipped", {
        reaction: "-1",
        reason: "non_message_item",
        targetTs: messageTs,
        channel,
      });
      return NextResponse.json({ ok: true });
    }

    after(async () => {
      try {
        const botId = await getBotUserId();
        if (botId && event.user === botId) {
          rlog("reaction_skipped", { reaction: "-1", reason: "bot_own_reaction", targetTs: messageTs, channel });
          return;
        }

        const msg = await fetchMessage(channel, messageTs);
        if (!msg || msg.user !== botId) {
          rlog("reaction_skipped", { reaction: "-1", reason: "target_not_bot_message", targetTs: messageTs, channel });
          return;
        }

        const context = await getQAContext(channel, messageTs);
        if (!context) {
          rlog("reaction_skipped", { reaction: "-1", reason: "no_qa_context", targetTs: messageTs, channel });
          return;
        }

        const threadTs = msg.thread_ts || messageTs;

        // Flag possibly related KB entries and docs (don't auto-remove).
        const kbEntries = await getAllKnowledge();
        const actions = buildCorrectionActions(context.references, kbEntries);

        await saveFeedback({
          type: "negative",
          question: context.question,
          detail: `👎 for: "${context.question.slice(0, 80)}" — flagged KB entries: ${actions.kbEntriesToFlag.length}, docs: ${actions.docsToProposeFix.length}`,
          timestamp: new Date().toISOString().split("T")[0],
        });
        rlog("feedback_saved", {
          type: "negative",
          answerTs: context.answerTs,
          chunkIndex: context.chunkIndex,
          chunkCount: context.chunkCount,
          latencyMs: Date.now() - context.postedAt,
          referenceCount: context.references.length,
          referenceTypes: context.referenceTypes,
          questionLength: context.question.length,
          answerLength: context.answer.length,
          questionSample: context.question.slice(0, 80),
        });

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

        // Store pending correction state so the next reply is saved as a
        // KB correction. Include a `pendingAt` timestamp so the
        // correction_saved event can compute timeSincePendingMs when the
        // user replies (closes the 👎 funnel).
        const pendingKey = `pending-correction:${channel}:${threadTs}`;
        const pendingAt = Date.now();
        const ttlSec = 86400;
        const { kv } = await import("@/lib/kv");
        await kv.set(
          pendingKey,
          JSON.stringify({
            question: context.question,
            references: context.references,
            flaggedKB: actions.kbEntriesToFlag.map((e) => e.entry),
            pendingAt,
            answerTs: context.answerTs,
          }),
          { ex: ttlSec },
        );
        rlog("correction_pending", {
          channel,
          threadTs,
          answerTs: context.answerTs,
          flaggedKBCount: actions.kbEntriesToFlag.length,
          flaggedDocCount: actions.docsToProposeFix.length,
          ttlSec,
        });

        await replyInThread(
          channel,
          threadTs,
          `:thinking_face: Thanks for the feedback.${flagText}\n\nWhat was wrong? Reply here and I'll save the correction.`,
        );
      } catch (err) {
        rlog("error", { flow: "reaction_thumbsdown", message: err instanceof Error ? err.message : String(err) });
        Sentry.captureException(err, { tags: { flow: "reaction_thumbsdown" } });
      } finally {
        await flushLogs(rlog, "reaction_thumbsdown");
      }
    });

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
