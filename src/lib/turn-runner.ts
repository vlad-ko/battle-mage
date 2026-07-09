// ── Turn runner: the agent-turn bodies behind /api/slack (#125) ──────
// Behavior-preserving extraction of the mention and thread-followup
// after() bodies out of route.ts, so the recovery sweep
// (/api/cron/sweep) can re-run a died turn through the EXACT same code
// path the webhook uses. The route stays a thin entry point: parse +
// guard + marker lifecycle + call a runner.
//
// flushLogs deliberately stays with the CALLER (route after() finally /
// end of sweep) — the sweep flushes once per sweep, not once per turn.

import * as Sentry from "@sentry/nextjs";
import {
  replyInThread,
  getBotUserId,
  fetchThreadMessages,
  updateMessage,
  deleteMessage,
  postReplyInChunks,
} from "@/lib/slack";
import { runAgent } from "@/lib/claude";
import { createIssue } from "@/lib/github";
import { executeIdempotent, issueIdempotencyKey } from "@/lib/idempotency";
import { type IssueProposal } from "@/tools/create-issue";
import {
  formatBatchProposalMessage,
  isBulkConfirmText,
  summarizeBatchResult,
  type BatchCreationOutcome,
} from "@/lib/issue-batch";
import { storeQAContext, saveFeedback, deriveReferenceTypes } from "@/lib/feedback";
import { formatReferences, rankReferences } from "@/lib/references";
import { toSlackMrkdwn } from "@/lib/mrkdwn";
import { buildThinkingMessage, THINKING_HEADER } from "@/lib/progress";
import { createThrottledUpdater } from "@/lib/slack-throttle";
import { formatReplyFooter, isReplyFooterEnabled } from "@/lib/reply-footer";
import {
  extractParticipantIds,
  resolveParticipants,
  type Participant,
} from "@/lib/slack-users";
import { type RequestLogger } from "@/lib/logger";
import { getCachedTopics } from "@/lib/repo-index";
import { matchTopicsToQuestion, buildQuestionHints } from "@/lib/topic-match";
import {
  buildConversationHistory,
  extractTranscriptTail,
} from "@/lib/thread-filter";
import {
  classifyTurn,
  decideEffort,
  evaluateFollowup,
  buildEffortHint,
  EFFORT_BUDGETS,
} from "@/lib/effort-routing";

// Shape of the pending-correction record stored under
// `pending-correction:{channel}:{threadTs}` when a user reacts 👎.
// Read by the thread-followup handler on the user's next message to
// save their correction to the KB. @upstash/redis auto-stringifies
// this on set and auto-parses on get.
export interface PendingCorrection {
  question: string;
  references: string[];
  flaggedKB: string[];
  pendingAt: number;
  answerTs: string;
}

// Shape of the pending-issue-batch record stored after the bot posts a
// proposal message. Indexed by the proposal message's first TS. See #122.
export interface PendingIssueBatch {
  proposals: IssueProposal[];
  proposedAt: number;
  requestedBy: string; // Slack user ID of the requester
  threadTs: string;
  messageFirstTs: string; // ts of the first chunk of the proposal message
}

const BATCH_KEY_PREFIX = "pending-issue-batch";
const BATCH_TTL_SEC = 86400; // 24h — stale batches fall off naturally
// Tombstone TTL: long enough to cover any plausible double-tap ✅ window
// on a single-proposal message whose body still matches the legacy parser.
// See PR #123 CodeRabbit finding — without this, a second reaction finds
// the canonical record deleted, falls to parseProposalFromMessage, and
// re-creates the issue.
const BATCH_TOMBSTONE_TTL_SEC = 3600;

export function batchKey(channel: string, firstTs: string): string {
  return `${BATCH_KEY_PREFIX}:${channel}:${firstTs}`;
}
export function batchThreadPointerKey(channel: string, threadTs: string): string {
  return `${BATCH_KEY_PREFIX}:thread:${channel}:${threadTs}`;
}
export function batchTombstoneKey(channel: string, firstTs: string): string {
  return `${BATCH_KEY_PREFIX}:done:${channel}:${firstTs}`;
}

/**
 * Atomically claim and execute a pending issue batch.
 *
 * Concurrency: the claim uses `kv.del` on the canonical key — Redis
 * DEL is atomic, so only the first caller sees `deleted === 1`. Any
 * racing handler (a second reaction, or a racing text command) sees
 * `0` and aborts without firing GitHub writes.
 *
 * Per-issue failures do not abort the rest: we use Promise.allSettled
 * and surface both creates and errors in the final summary.
 */
export async function executeBatchCreation(
  channel: string,
  threadTs: string,
  firstTs: string,
  confirmingUser: string,
  confirmVia: "reaction" | "text",
  rlog: RequestLogger,
): Promise<{ claimed: boolean }> {
  const { kv } = await import("@/lib/kv");
  const primaryKey = batchKey(channel, firstTs);

  // Read the batch before claiming so we have the data to create issues
  // if we win the del race.
  const batch = await kv.get<PendingIssueBatch>(primaryKey);
  if (!batch) {
    return { claimed: false };
  }

  const deleted = await kv.del(primaryKey);
  if (deleted === 0) {
    // Another handler won the race between get and del.
    rlog("issue_batch_claim_lost", { channel, firstTs, confirmVia });
    return { claimed: false };
  }

  // Tombstone the claim so a second ✅ on the same message can't fall
  // through to the legacy parser and re-create the issue. The legacy
  // fallback checks this before parsing message text. 1h is enough for
  // any plausible double-tap; long-lived record stays under the canonical
  // 24h TTL of the original batch.
  try {
    await kv.set(batchTombstoneKey(channel, firstTs), 1, {
      ex: BATCH_TOMBSTONE_TTL_SEC,
    });
  } catch {
    // Non-fatal; Sentry already captured via the kv wrapper. Worst case
    // a racing second reaction takes the legacy path.
  }

  // Best-effort cleanup of the thread pointer. We don't care if it was
  // already removed — TTL would catch it anyway.
  try {
    await kv.del(batchThreadPointerKey(channel, threadTs));
  } catch {
    // Non-fatal; Sentry already captured via the kv wrapper.
  }

  rlog("issue_batch_confirmed", {
    count: batch.proposals.length,
    confirmVia,
    confirmingUser,
    requestedBy: batch.requestedBy,
    latencyMs: Date.now() - batch.proposedAt,
    channel,
    threadTs,
  });

  const createStart = Date.now();
  // Innermost idempotency guard (#125): the del-claim above serializes
  // batch claims, but Slack's at-least-once delivery and the legacy
  // parser fallback can still re-reach createIssue. Content-addressed
  // keys make every duplicate a replay (recorded URL) instead of a
  // second GitHub issue.
  const settled = await Promise.allSettled(
    batch.proposals.map((p) =>
      executeIdempotent(
        issueIdempotencyKey({ title: p.title, body: p.body, labels: p.labels }),
        () => createIssue(p.title, p.body, p.labels),
        rlog,
      ),
    ),
  );

  const outcomes: BatchCreationOutcome[] = settled.map((res, i) => {
    const proposal = batch.proposals[i];
    if (res.status === "fulfilled") {
      if (res.value.outcome === "in_flight") {
        // Another confirmation holds the pending lock for this exact
        // proposal right now — surface as an error-shaped outcome so
        // the summary doesn't claim success for an issue we can't see.
        return {
          status: "error",
          proposal,
          errorMessage: "already being created by another confirmation",
        };
      }
      // created and replayed both carry the (recorded) issue.
      return { status: "success", proposal, issue: res.value.result };
    }
    const errorMessage =
      res.reason instanceof Error ? res.reason.message : String(res.reason);
    // Per-issue Sentry capture so a rate-limit spike on one title doesn't
    // hide under the summary event. Tagged for dashboard filtering.
    Sentry.captureException(res.reason, {
      tags: { flow: "issue_create", batchSize: String(batch.proposals.length) },
      extra: { proposalTitle: proposal.title },
    });
    rlog("issue_create_error", {
      title: proposal.title,
      errorClass:
        res.reason instanceof Error ? res.reason.constructor.name : "Unknown",
      errorMessage: errorMessage.slice(0, 200),
    });
    return { status: "error", proposal, errorMessage };
  });

  const successCount = outcomes.filter((o) => o.status === "success").length;
  const failureCount = outcomes.length - successCount;
  rlog("issue_batch_created", {
    totalCount: outcomes.length,
    successCount,
    failureCount,
    durationMs: Date.now() - createStart,
    numbers: outcomes
      .filter((o) => o.status === "success")
      .map((o) => (o as Extract<BatchCreationOutcome, { status: "success" }>).issue.number),
    channel,
    threadTs,
  });

  await replyInThread(channel, threadTs, summarizeBatchResult(outcomes));
  return { claimed: true };
}

// ── Mention turn ──────────────────────────────────────────────────────

export interface MentionTurnParams {
  channel: string;
  threadTs: string;
  /** Slack user ID of the mentioning user. */
  user: string;
  /** Raw message text (bot mention token still present). */
  text: string;
  /** Whether the mention arrived inside an existing thread. The sweep
   * passes true — a died turn always has its thread rooted at threadTs
   * by then, and fetching it is a safe superset of the fresh-mention
   * participant derivation. */
  inThread: boolean;
  rlog: RequestLogger;
}

/**
 * The full @bm mention turn: thinking message → context assembly →
 * agent loop → answer/proposal post → Q&A context storage. Extracted
 * verbatim from the route's after() body so the recovery sweep can
 * re-run it. Handles its own errors (visible error reply); the caller
 * owns marker cleanup and flushLogs.
 */
export async function runMentionTurn(params: MentionTurnParams): Promise<void> {
  const { channel, threadTs, user, text: userMessage, inThread, rlog } = params;
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
    // Recent-thread tail for the effort classifier — empty for fresh
    // top-level mentions (the question alone is enough to bucket).
    let mentionTranscript = "";
    const botId = await getBotUserId();
    if (inThread) {
      const threadMsgs = await fetchThreadMessages(channel, threadTs);
      if (botId) {
        mentionHistory = buildConversationHistory(threadMsgs, botId);
      }
      mentionTranscript = extractTranscriptTail(threadMsgs, botId ?? "");
      const ids = extractParticipantIds(threadMsgs, botId);
      if (ids.length > 0) {
        mentionParticipants = await resolveParticipants(ids);
      }
    } else {
      // Fresh top-level mention — the only participant signal is the
      // invoking user + anyone they mentioned in the message body.
      const ids = extractParticipantIds(
        [{ user, text: userMessage }],
        botId,
      );
      if (ids.length > 0) {
        mentionParticipants = await resolveParticipants(ids);
      }
    }

    // Pre-match question against topic index for concrete file hints.
    // The effort classifier (#126) runs in parallel — on the mention
    // path shouldReply is NEVER consulted (the user explicitly invoked
    // the bot); the classifier only buckets the question so the agent
    // gets a right-sized round budget and answer target.
    const [topics, mentionClassification] = await Promise.all([
      getCachedTopics(),
      classifyTurn(
        { invocation: "mention", transcript: mentionTranscript, question: cleanMessage },
        { log: rlog },
      ),
    ]);
    const mentionEffort = decideEffort(mentionClassification);
    const topicMatches = matchTopicsToQuestion(cleanMessage, topics);
    const augmentedMessage =
      buildQuestionHints(cleanMessage, topicMatches) + buildEffortHint(mentionEffort);
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
      { maxRounds: EFFORT_BUDGETS[mentionEffort].maxRounds, effort: mentionEffort },
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

    if (result.issueProposals.length > 0) {
      const proposals = result.issueProposals;
      const proposalBlock = formatBatchProposalMessage(proposals);
      const finalBody = [text, "", proposalBlock].join("\n") + refsFooter + replyFooter;

      const posted = await postReplyInChunks({
        channel,
        threadTs,
        thinkingTs,
        text: finalBody,
      });
      // Only mark as finalized when we actually posted. A 0-chunk
      // result (empty body) falls through to the finally cleanup.
      if (posted.chunks > 0) thinkingTs = undefined;

      // Persist the batch so confirmation (reaction OR thread text)
      // can create without re-parsing Slack message text. Key is the
      // first chunk's ts; thread pointer enables "confirm all" text.
      if (posted.firstTs) {
        const { kv } = await import("@/lib/kv");
        const record: PendingIssueBatch = {
          proposals,
          proposedAt: Date.now(),
          requestedBy: user,
          threadTs,
          messageFirstTs: posted.firstTs,
        };
        await kv.set(batchKey(channel, posted.firstTs), record, { ex: BATCH_TTL_SEC });
        await kv.set(
          batchThreadPointerKey(channel, threadTs),
          posted.firstTs,
          { ex: BATCH_TTL_SEC },
        );
        rlog("issue_batch_proposed", {
          count: proposals.length,
          threadTs,
          channel,
          firstTs: posted.firstTs,
          sampleTitles: proposals.slice(0, 3).map((p) => p.title.slice(0, 80)),
          requestingUser: user,
        });
      }
      rlog("answer_posted", {
        channel,
        threadTs,
        chunks: posted.chunks,
        kind: "proposal",
        proposalCount: proposals.length,
      });
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
    rlog("agent_turn_failed", { flow: "mention", message: msg });
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
  }
}

// ── Thread-followup turn ──────────────────────────────────────────────

export interface FollowupTurnParams {
  channel: string;
  threadTs: string;
  /** Slack user ID of the replying user. */
  user: string;
  /** Raw message text. */
  text: string;
  /** Bot user ID if the caller already resolved it (the webhook route
   * does, for its mention-skip guard). The runner re-resolves when
   * absent — e.g. on a sweep re-run. */
  botId?: string;
  rlog: RequestLogger;
}

/**
 * The full thread-followup turn: pending-correction intake →
 * bulk-confirm interception → participation check → follow-up
 * classifier gate (#126, fail-closed) → agent loop → answer/proposal
 * post. Extracted from the route's after() body so the recovery sweep
 * can re-run it. Handles its own errors;
 * the caller owns marker cleanup and flushLogs.
 */
export async function runFollowupTurn(params: FollowupTurnParams): Promise<void> {
  const { channel, threadTs, user, text: userMessage, botId, rlog } = params;
  let thinkTs: string | undefined;
  try {
    // Check for pending correction (from a 👎 reaction)
    const { kv } = await import("@/lib/kv");
    const pendingKey = `pending-correction:${channel}:${threadTs}`;
    const pending = await kv.get<PendingCorrection>(pendingKey);
    if (pending) {
      // This reply is a correction — save directly to KB
      const { saveKnowledgeEntry, markKnowledgeSuperseded } = await import(
        "@/lib/knowledge"
      );

      // Strip @-mentions and trim, matching the normalization used
      // for questions, so raw Slack tokens don't end up in the KB.
      const correctionText = userMessage.replace(/<@[A-Z0-9]+>/g, "").trim();
      const correctionId = await saveKnowledgeEntry(correctionText);

      // Clear the pending state as soon as the correction is durably
      // saved — everything after this point is best-effort. If a later
      // step throws, the error reply must NOT leave pending state
      // behind, or the user's re-reply would save a duplicate entry.
      await kv.del(pendingKey);

      // Retire the KB entries flagged at 👎 time: mark them superseded
      // by the correction instead of leaving them visible (or deleting
      // them and losing history). Text-matched; entries already
      // superseded or archived in the meantime are skipped. See #124.
      let supersededCount = 0;
      try {
        for (const flaggedText of pending.flaggedKB) {
          if (await markKnowledgeSuperseded(flaggedText, correctionId)) {
            supersededCount++;
          }
        }
      } catch (err) {
        // Correction is saved; a KV flake while retiring old entries
        // must not fail the flow. Worst case a stale entry stays
        // visible — observable via the count on correction_saved.
        rlog("correction_supersede_error", {
          channel,
          threadTs,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      // Save the negative feedback NOW with the actual correction text
      await saveFeedback({
        type: "negative",
        question: pending.question || "",
        detail: `Correction: "${correctionText.slice(0, 200)}"`,
        timestamp: new Date().toISOString().split("T")[0],
      });
      // Close the 👎 → correction funnel with latency from the
      // moment 👎 was registered.
      rlog("correction_saved", {
        channel,
        threadTs,
        answerTs: pending.answerTs ?? null,
        correctionLength: correctionText.length,
        timeSincePendingMs: Date.now() - pending.pendingAt,
        flaggedKBCount: pending.flaggedKB.length,
        supersededCount,
        correctionSample: correctionText.slice(0, 100),
      });

      await replyInThread(
        channel,
        threadTs,
        `:white_check_mark: Saved to knowledge base: _"${correctionText.slice(0, 100)}"_`,
      );
      return;
    }

    // ── Bulk-confirm interception (#122) ────────────────────────────
    // If there's a pending issue batch in this thread AND the user's
    // reply is a bulk-confirm phrase ("confirm all", "yes", etc.),
    // create all issues instead of running the agent. `isBulkConfirmText`
    // is strict (short intent-only phrases) so normal conversation is
    // unaffected.
    if (isBulkConfirmText(userMessage)) {
      const pointerKey = batchThreadPointerKey(channel, threadTs);
      const batchFirstTs = await kv.get<string>(pointerKey);
      if (batchFirstTs) {
        const outcome = await executeBatchCreation(
          channel,
          threadTs,
          batchFirstTs,
          user,
          "text",
          rlog,
        );
        if (outcome.claimed) return;
        // Not claimed → either the batch expired or another handler
        // consumed it. Fall through to the normal agent flow so the
        // user still gets a response.
      }
    }

    // Fetch thread messages — used for both participation check and context
    const bid = botId || (await getBotUserId());
    const threadMessages = await fetchThreadMessages(channel, threadTs);
    const botInThread = bid ? threadMessages.some((m) => m.user === bid) : false;
    if (!bid || !botInThread) return;

    const cleanMessage = userMessage.replace(/<@[A-Z0-9]+>/g, "").trim();

    // Follow-up gate (#126): the structural heuristic above only says
    // "maybe" — ask the fast-model classifier whether this message is
    // actually addressed to the bot. Fail-closed: any classifier
    // error/timeout/low-confidence verdict means we stay silent. Runs
    // BEFORE the thinking message so a decline produces ZERO Slack
    // writes — just the log event below. The decline returns from
    // inside the caller's try, so marker cleanup (route after()
    // finally / sweep finally) still runs — a sweep-retried follow-up
    // re-runs this gate, and a declined retry cleans up its marker
    // instead of dangling into give_up.
    const followupEval = await evaluateFollowup(
      {
        invocation: "followup",
        transcript: extractTranscriptTail(threadMessages, bid),
        question: cleanMessage,
      },
      { log: rlog },
    );
    if (!followupEval.proceed) {
      rlog("followup_reply_declined", {
        reason:
          followupEval.decision === null
            ? "classifier_unavailable"
            : followupEval.decision.shouldReply
              ? "low_confidence"
              : "not_addressed",
        confidence: followupEval.decision?.shouldReplyConfidence ?? null,
        channel,
        threadTs,
      });
      return;
    }
    rlog("followup_agent_start", { channel, threadTs });

    thinkTs = await replyInThread(
      channel, threadTs,
      THINKING_HEADER,
    );

    // Build proper multi-turn conversation history from thread
    // (uses Anthropic's native message format, not string hacking)
    const history = buildConversationHistory(threadMessages, bid);

    // Thread participants for #80 — resolve IDs now so the agent can
    // @-mention teammates in its answer.
    const followupParticipantIds = extractParticipantIds(threadMessages, bid);
    const followupParticipants = followupParticipantIds.length > 0
      ? await resolveParticipants(followupParticipantIds)
      : undefined;

    // Pre-match for thread follow-ups too; the effort hint from the
    // classifier rides along on the user message (never the system
    // prompt — see effort-routing.ts on prompt caching).
    const followupTopics = await getCachedTopics();
    const followupMatches = matchTopicsToQuestion(cleanMessage, followupTopics);
    const followupMessage =
      buildQuestionHints(cleanMessage, followupMatches) + buildEffortHint(followupEval.effort);

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
      { maxRounds: EFFORT_BUDGETS[followupEval.effort].maxRounds, effort: followupEval.effort },
    );
    await followupProgress.flush();

    const text = toSlackMrkdwn(result.text);
    const rankedRefs = rankReferences(result.references, result.text);
    const refsFooter = formatReferences(rankedRefs);
    // Optional compact telemetry footer (#79) — mirrors the mention flow.
    const replyFooter = isReplyFooterEnabled(process.env)
      ? formatReplyFooter(result.metrics, rlog.requestId)
      : "";

    if (result.issueProposals.length > 0) {
      const proposals = result.issueProposals;
      const proposalBlock = formatBatchProposalMessage(proposals);
      const finalBody = [text, "", proposalBlock].join("\n") + refsFooter + replyFooter;

      const posted = await postReplyInChunks({
        channel,
        threadTs,
        thinkingTs: thinkTs,
        text: finalBody,
      });
      if (posted.chunks > 0) thinkTs = undefined;

      if (posted.firstTs) {
        const record: PendingIssueBatch = {
          proposals,
          proposedAt: Date.now(),
          requestedBy: user,
          threadTs,
          messageFirstTs: posted.firstTs,
        };
        await kv.set(batchKey(channel, posted.firstTs), record, { ex: BATCH_TTL_SEC });
        await kv.set(
          batchThreadPointerKey(channel, threadTs),
          posted.firstTs,
          { ex: BATCH_TTL_SEC },
        );
        rlog("issue_batch_proposed", {
          count: proposals.length,
          threadTs,
          channel,
          firstTs: posted.firstTs,
          sampleTitles: proposals.slice(0, 3).map((p) => p.title.slice(0, 80)),
          requestingUser: user,
        });
      }
      rlog("answer_posted", {
        channel,
        threadTs,
        chunks: posted.chunks,
        kind: "proposal",
        proposalCount: proposals.length,
      });
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
    rlog("agent_turn_failed", { flow: "thread_followup", message: msg });
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
  }
}
