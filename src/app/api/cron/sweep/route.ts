// ── Recovery sweep (#125) ─────────────────────────────────────────────
// Vercel Cron entry point (see vercel.json — every 5 minutes). Walks
// the processing:index zset, classifies each in-flight marker via
// decideSweepAction, and:
//
//   wait    → live or recently started turn — skip.
//   orphan  → index entry outlived its marker's 24h TTL — drop it.
//   retry   → first-attempt turn whose invocation is provably dead
//             (marker age > 15 min > route maxDuration): win the NX
//             claim (losing racer skips), verify the thread wasn't
//             already answered, then re-run the turn through the SAME
//             turn-runner code path the webhook uses.
//   give_up → the retry also died: post a visible failure notice so
//             the user is never left with silence.
//
// Phase 2 (#136): after recovery, the same sweep runs passive KB
// extraction (see src/lib/kb-runner.ts) under its own try/catch — a KB
// failure never fails recovery.
//
// Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Exact
// match, fail closed (unset secret denies everything).

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { kv } from "@/lib/kv";
import { createRequestLogger, flushLogs } from "@/lib/logger";
import { fetchThreadMessages, getBotUserId, replyInThread } from "@/lib/slack";
import { THINKING_HEADER } from "@/lib/progress";
import {
  processingMarkerKey,
  parseIndexMember,
  decideSweepAction,
  buildRetryMarker,
  isAuthorizedCronRequest,
  acquireSweepClaim,
  writeProcessingMarker,
  clearProcessingMarker,
  PROCESSING_INDEX_KEY,
  type ProcessingMarker,
} from "@/lib/recovery";
import { runMentionTurn, runFollowupTurn } from "@/lib/turn-runner";
import { runKbExtractionSweep, type KbSweepSummary } from "@/lib/kb-runner";

// A retried turn is a full agent run — give the sweep the same budget
// as the Slack route.
export const maxDuration = 300;

/**
 * Already-answered guard: true when the bot posted a REAL message in
 * the thread after the marker was written. Excludes leftover thinking
 * messages — a turn that died mid-run leaves its "Thinking…" message
 * behind (the finally that deletes it never ran), and counting it
 * would suppress every legitimate retry.
 */
function hasBotAnswerAfter(
  messages: { user?: string; text?: string; ts?: string }[],
  botId: string | undefined,
  startedAtMs: number,
): boolean {
  if (!botId) return false;
  return messages.some(
    (m) =>
      m.user === botId &&
      m.ts !== undefined &&
      parseFloat(m.ts) * 1000 > startedAtMs &&
      !(m.text ?? "").startsWith(THINKING_HEADER),
  );
}

export async function GET(request: NextRequest) {
  const rlog = createRequestLogger();

  if (
    !isAuthorizedCronRequest(
      request.headers.get("authorization"),
      process.env.CRON_SECRET,
    )
  ) {
    rlog("recovery_sweep_unauthorized");
    return new NextResponse("Unauthorized", { status: 401 });
  }

  let scanned = 0;
  let retried = 0;
  let gaveUp = 0;
  let orphaned = 0;

  try {
    const members = (await kv.zrange(PROCESSING_INDEX_KEY, 0, -1)) as string[];
    const now = Date.now();

    for (const member of members) {
      scanned++;
      try {
        const parsed = parseIndexMember(member);
        if (!parsed) {
          await kv.zrem(PROCESSING_INDEX_KEY, member);
          rlog("recovery_marker_orphaned", { member: member.slice(0, 40), reason: "malformed" });
          orphaned++;
          continue;
        }
        const { channel, threadTs } = parsed;
        const marker = await kv.get<ProcessingMarker>(
          processingMarkerKey(channel, threadTs),
        );
        const action = decideSweepAction(marker, now);

        if (action === "wait") continue;

        if (action === "orphan") {
          await kv.zrem(PROCESSING_INDEX_KEY, member);
          rlog("recovery_marker_orphaned", { channel, threadTs });
          orphaned++;
          continue;
        }

        // retry / give_up require winning a NON-DESTRUCTIVE claim:
        // SET NX on processing:claim:<channel>:<threadTs> (short TTL).
        // A concurrently running sweep (Hobby-plan cadence drift,
        // manual trigger) loses NX and skips. Unlike the previous
        // del-claim, the marker survives any failure past this point —
        // a throw below leaves marker + index intact for the next
        // sweep (after the claim TTL expires) to retry the decision.
        const claimed = await acquireSweepClaim(channel, threadTs, rlog.requestId);
        if (!claimed) {
          rlog("recovery_sweep_claim_lost", { channel, threadTs });
          continue;
        }

        if (action === "give_up") {
          // Notice FIRST, cleanup AFTER — if Slack fails here the
          // marker + index survive and the next sweep re-attempts the
          // notice instead of silently losing the turn.
          await replyInThread(
            channel,
            threadTs,
            "I hit an error processing your question — please re-ask.",
          );
          await clearProcessingMarker(channel, threadTs);
          rlog("recovery_sweep_gave_up", {
            channel,
            threadTs,
            attempt: marker!.attempt,
            requestId: marker!.requestId,
          });
          gaveUp++;
          continue;
        }

        // action === "retry": guard against a turn that actually
        // finished but died between posting the answer and clearing
        // its marker — retrying would double-answer.
        const botId = await getBotUserId();
        const threadMsgs = await fetchThreadMessages(channel, threadTs);
        if (hasBotAnswerAfter(threadMsgs, botId, marker!.startedAt)) {
          await clearProcessingMarker(channel, threadTs);
          rlog("recovery_sweep_already_answered", { channel, threadTs });
          continue;
        }

        // The retry marker OVERWRITES the same marker key — at every
        // instant either the old or the new marker exists, never
        // neither, so a crash anywhere on this path stays sweepable.
        const retryMarker = buildRetryMarker(marker!, now);
        await writeProcessingMarker(retryMarker);
        rlog("recovery_sweep_retried", {
          channel,
          threadTs,
          eventType: retryMarker.eventType,
          attempt: retryMarker.attempt,
          originalRequestId: retryMarker.requestId,
        });
        retried++;

        try {
          if (retryMarker.eventType === "app_mention") {
            await runMentionTurn({
              channel,
              threadTs,
              user: retryMarker.user,
              text: retryMarker.text,
              inThread: true,
              rlog,
            });
          } else {
            await runFollowupTurn({
              channel,
              threadTs,
              user: retryMarker.user,
              text: retryMarker.text,
              rlog,
            });
          }
        } finally {
          // Mirrors the webhook route's finally: handled errors clear
          // the retry marker; only container death leaves it — and the
          // next sweep sees attempt 1 and gives up visibly.
          await clearProcessingMarker(channel, threadTs);
        }
      } catch (err) {
        // One bad member must not abort the rest of the sweep — and
        // because the claim above is non-destructive, a failure here
        // leaves marker + index recoverable BY DESIGN: the next sweep
        // (after the claim TTL) retries the decision.
        rlog("recovery_sweep_member_failed", {
          member: member.slice(0, 60),
          errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err),
        });
        Sentry.captureException(err, { tags: { flow: "cron_sweep" } });
      }
    }

    // ── Phase 2: passive KB extraction (#136) ─────────────────────────
    // Piggybacks on the same cron cadence. Own try/catch — a KB-side
    // failure must NEVER fail recovery: phase 1's results stand and the
    // sweep still returns 200 so Vercel Cron doesn't flag the job.
    let kb: KbSweepSummary | null = null;
    try {
      kb = await runKbExtractionSweep(rlog);
    } catch (err) {
      rlog("kb_extract_sweep_failed", {
        errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
      Sentry.captureException(err, { tags: { flow: "kb_extract_sweep" } });
    }

    rlog("recovery_sweep_complete", { scanned, retried, gaveUp, orphaned, kb });
    return NextResponse.json({ ok: true, scanned, retried, gaveUp, orphaned, kb });
  } catch (err) {
    rlog("recovery_sweep_failed", {
      errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    Sentry.captureException(err, { tags: { flow: "cron_sweep" } });
    return NextResponse.json({ ok: false }, { status: 500 });
  } finally {
    // Same tail-drop rule as every after() body (#98): explicitly drain
    // the Sentry buffer before the container freezes.
    await flushLogs(rlog, "cron_sweep");
  }
}
