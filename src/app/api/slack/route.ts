import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  verifySlackSignature,
  replyInThread,
  fetchMessage,
  getBotUserId,
} from "@/lib/slack";
import { createIssue } from "@/lib/github";
import { executeIdempotent, issueIdempotencyKey } from "@/lib/idempotency";
import { parseProposalFromMessage } from "@/tools/create-issue";
import { getQAContext, saveFeedback } from "@/lib/feedback";
import { getAllKnowledge } from "@/lib/knowledge";
import { buildCorrectionActions } from "@/lib/auto-correct";
import { createRequestLogger, flushLogs } from "@/lib/logger";
import { isAddressedToOtherUser } from "@/lib/thread-filter";
import {
  writeProcessingMarker,
  clearProcessingMarker,
} from "@/lib/recovery";
import {
  runMentionTurn,
  runFollowupTurn,
  executeBatchCreation,
  batchTombstoneKey,
  type PendingCorrection,
} from "@/lib/turn-runner";
import { executeKbBatchSave } from "@/lib/kb-runner";
import { kbBatchTombstoneKey } from "@/lib/kb-proposals";

// Give the after() bodies the full Fluid-compute budget. Next.js reads
// this statically, so it must be a literal — SLACK_ROUTE_MAX_DURATION_SEC
// in src/lib/recovery.ts mirrors it and the recovery tests pin the
// invariant PROCESSING_MAX_AGE_MS > maxDuration (a marker older than
// max-age cannot belong to a live invocation). Keep the two in sync.
export const maxDuration = 300;

/**
 * Slack Events API webhook handler.
 *
 * Handles:
 * - URL verification challenge (Slack app setup)
 * - app_mention events (@bm invocation)
 *
 * Slack requires a 200 OK within 3 seconds. We ack immediately
 * and process the AI + GitHub calls asynchronously via after().
 *
 * Recovery (#125): the FIRST step of each after() body persists a
 * ProcessingMarker; the after() finally clears it. A finally covers
 * every handled error path — only container death leaves a marker
 * behind, and the cron sweep (/api/cron/sweep) retries exactly that
 * set via the same turn-runner code path. The write lives INSIDE
 * after(), never on the ack path: two KV round-trips before the 200 OK
 * could breach Slack's 3-second deadline under KV slowness, triggering
 * Slack retries and duplicate processing (PR #133 review).
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
      try {
        // Recovery marker (#125): written best-effort as the FIRST step
        // of the async body — kept off the ack path so KV latency can
        // never push the 200 OK past Slack's 3-second deadline (PR #133
        // review). Accepted trade: a container death in the tiny window
        // between the ack and this write loses recovery for that turn.
        await writeProcessingMarker({
          eventType: "app_mention",
          channel,
          threadTs,
          user: event.user,
          text: userMessage,
          startedAt: Date.now(),
          attempt: 0,
          requestId: rlog.requestId,
        });
        await runMentionTurn({
          channel,
          threadTs,
          user: event.user,
          text: userMessage,
          inThread: !!event.thread_ts,
          rlog,
        });
      } finally {
        // Handled errors reach here too — only container death skips
        // this clear, which is exactly the set the sweep recovers.
        await clearProcessingMarker(channel, threadTs);
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
      try {
        // Recovery marker (#125) — mirrors the mention flow: first step
        // inside after(), off the ack path (PR #133 review).
        await writeProcessingMarker({
          eventType: "thread_followup",
          channel,
          threadTs,
          user: event.user,
          text: userMessage,
          startedAt: Date.now(),
          attempt: 0,
          requestId: rlog.requestId,
        });
        await runFollowupTurn({
          channel,
          threadTs,
          user: event.user,
          text: userMessage,
          botId,
          rlog,
        });
      } finally {
        await clearProcessingMarker(channel, threadTs);
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

        const threadTs = msg.thread_ts || messageTs;

        // Preferred path (#122): batch record in KV keyed by this message's
        // ts. Handles 1-proposal AND N-proposal batches uniformly.
        const outcome = await executeBatchCreation(
          channel,
          threadTs,
          messageTs,
          reactingUser,
          "reaction",
          rlog,
        );
        if (outcome.claimed) return;

        // KB proposal batch (#136): the reacted-on message may be a
        // passive-KB proposal instead of an issue proposal. Same claim
        // protocol, checked second so issue batches keep precedence.
        const kbOutcome = await executeKbBatchSave(
          channel,
          threadTs,
          messageTs,
          reactingUser,
          "reaction",
          rlog,
        );
        if (kbOutcome.claimed) return;

        // Tombstone guard: a prior confirmation already claimed this
        // message's batch. Without this check, a second ✅ on the same
        // post-#122 single-proposal message would fall through to the
        // legacy parser (body still inlined in the message text) and
        // create the issue a second time. See CodeRabbit feedback on
        // PR #123.
        const { kv } = await import("@/lib/kv");
        const tombstone = await kv.get(batchTombstoneKey(channel, messageTs));
        if (tombstone) {
          rlog("issue_batch_reaction_after_claim", { channel, messageTs });
          return;
        }

        // KB tombstone (#136): a second ✅ on an already-claimed KB
        // proposal returns SILENTLY — there is deliberately no
        // text-parse fallback for KB proposals (K-P4), so nothing
        // below this line may act on one.
        const kbTombstone = await kv.get(kbBatchTombstoneKey(channel, messageTs));
        if (kbTombstone) {
          rlog("kb_batch_reaction_after_claim", { channel, messageTs });
          return;
        }

        // Legacy fallback: in-flight pre-#122 proposal messages whose
        // KV record expired (or never existed). Parse from message text
        // exactly as before. Drops out naturally after the 24h TTL
        // window from rollout.
        const proposal = parseProposalFromMessage(msg.text);
        if (!proposal) return; // Not a proposal message — ignore

        // Idempotency guard (#125): a double-tap ✅ past the tombstone
        // window, or a Slack event redelivery, re-reaches this parser.
        // The content-addressed key (labels: undefined ≡ []) replays the
        // recorded issue instead of creating a duplicate.
        const idem = await executeIdempotent(
          issueIdempotencyKey({
            title: proposal.title,
            body: proposal.body,
            labels: proposal.labels,
          }),
          () => createIssue(proposal.title, proposal.body, proposal.labels),
          rlog,
        );
        if (idem.outcome === "in_flight") {
          // A racing confirmation is creating this exact issue right
          // now — it will post the success reply. Stay silent.
          rlog("issue_create_in_flight", { via: "legacy_parser", channel, messageTs });
          return;
        }
        const issue = idem.result;
        rlog("issue_created", { number: issue.number, via: "legacy_parser" });
        await replyInThread(
          channel,
          threadTs,
          `:white_check_mark: Created issue *#${issue.number}*: <${issue.url}|${issue.title}>`,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        rlog("webhook_handler_failed", { flow: "reaction_checkmark", message: errMsg });
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
        rlog("webhook_handler_failed", { flow: "reaction_thumbsup", message: err instanceof Error ? err.message : String(err) });
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
          notes.push("*Possibly related KB entries* (a correction reply retires these, keeping history):");
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
        const pendingRecord: PendingCorrection = {
          question: context.question,
          references: context.references,
          flaggedKB: actions.kbEntriesToFlag.map((e) => e.entry),
          pendingAt,
          answerTs: context.answerTs,
        };
        await kv.set(pendingKey, pendingRecord, { ex: ttlSec });
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
        rlog("webhook_handler_failed", { flow: "reaction_thumbsdown", message: err instanceof Error ? err.message : String(err) });
        Sentry.captureException(err, { tags: { flow: "reaction_thumbsdown" } });
      } finally {
        await flushLogs(rlog, "reaction_thumbsdown");
      }
    });

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
