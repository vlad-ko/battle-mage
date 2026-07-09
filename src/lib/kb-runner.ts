/**
 * Passive KB learning — orchestration (#136).
 *
 * Side-effect layer over the pure trio (kb-extract / kb-gate /
 * kb-proposals). Two flows live here:
 *
 * 1. `runKbExtractionSweep` — phase 2 of /api/cron/sweep. Walks the
 *    kb-extract:index zset, classifies each quiet thread via
 *    decideKbExtraction, wins a non-destructive NX claim (structural
 *    clone of recovery.ts acquireSweepClaim), extracts candidates with
 *    the fast model, gates them deterministically, and posts a proposal
 *    message. NOTHING writes to the KB here — proposals only.
 *
 * 2. `executeKbBatchSave` — the confirmation side (✅ reaction or
 *    "confirm all" text). Structural clone of turn-runner.ts's
 *    executeBatchCreation claim protocol: get → atomic del claim →
 *    tombstone → pointer cleanup → allSettled saves → summary post.
 *    There is deliberately NO text-parse fallback for KB proposals
 *    (invariant K-P4): the KV record is the only path to a save.
 *
 * Plus `recordKbThreadActivity`, the best-effort discovery-index bump
 * the turn runner calls after every posted answer.
 */

import * as Sentry from "@sentry/nextjs";
import { kv } from "./kv";
import { log as defaultLog, type LogFn, type RequestLogger } from "./logger";
import {
  slack,
  replyInThread,
  fetchThreadTail,
  getBotUserId,
} from "./slack";
import { indexMember, parseIndexMember } from "./recovery";
import {
  extractKbCandidates,
  buildExtractionTranscript,
  MAX_EXTRACTION_MESSAGES,
} from "./kb-extract";
import {
  gateKbCandidates,
  isExtractableChannel,
  KB_SAVED_CONFIRMATION_PREFIX, // re-exported for the turn runner's reply
} from "./kb-gate";
import {
  decideKbExtraction,
  formatKbProposalMessage,
  summarizeKbSaveResult,
  kbStateKey,
  kbClaimKey,
  kbBatchKey,
  kbBatchThreadPointerKey,
  kbBatchTombstoneKey,
  KB_EXTRACT_INDEX_KEY,
  KB_EXTRACT_SCAN_LIMIT,
  MAX_KB_EXTRACT_PER_SWEEP,
  MAX_KB_EXTRACTION_ATTEMPTS,
  KB_STATE_TTL_SEC,
  KB_EXTRACT_CLAIM_TTL_SEC,
  KB_BATCH_TTL_SEC,
  KB_BATCH_TOMBSTONE_TTL_SEC,
  type KbThreadState,
  type KbSaveOutcome,
  type PendingKbBatch,
} from "./kb-proposals";
import {
  saveKnowledgeEntry,
  markKnowledgeSuperseded,
  getAllKnowledge,
} from "./knowledge";

export { KB_SAVED_CONFIRMATION_PREFIX };

// ── Activity recording ────────────────────────────────────────────────

/**
 * Bump the KB discovery index for a thread the bot just answered in.
 * Best-effort: a KV flake must never break the reply flow. Called by
 * turn-runner after every answer_posted (mention + follow-up, answer +
 * proposal paths) — and deliberately NOT after posting a KB proposal,
 * which would re-arm extraction on the extractor's own output.
 */
export async function recordKbThreadActivity(
  channel: string,
  threadTs: string,
  log: LogFn = defaultLog,
): Promise<void> {
  try {
    await kv.zadd(KB_EXTRACT_INDEX_KEY, {
      score: Date.now(),
      member: indexMember(channel, threadTs),
    });
  } catch (err) {
    log("kb_activity_record_failed", {
      channel,
      threadTs,
      errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
  }
}

// ── Sweep claim (structural clone of recovery.ts acquireSweepClaim) ──

/**
 * Non-destructive extraction claim: SET NX with a short TTL on a
 * SEPARATE key. The index entry and state survive any failure after a
 * won claim — the next sweep (once the claim TTL expires) simply
 * retries the decision. The losing racer gets false and skips.
 */
async function acquireKbExtractClaim(
  channel: string,
  threadTs: string,
  requestId: string,
): Promise<boolean> {
  const result = await kv.set(
    kbClaimKey(channel, threadTs),
    { claimedAt: Date.now(), requestId },
    { nx: true, ex: KB_EXTRACT_CLAIM_TTL_SEC },
  );
  // Upstash SET NX returns null when the key already exists.
  return result !== null;
}

// ── Channel publicness (fail closed) ─────────────────────────────────

/**
 * Positively confirm a channel is PUBLIC via conversations.info.
 * Returns:
 * - "public"     — extraction may proceed;
 * - "non_public" — confirmed private/DM/MPIM: prune the index entry,
 *                  this thread can never become extractable;
 * - "unknown"    — info unavailable (missing channels:read scope, API
 *                  error): FAIL CLOSED, skip WITHOUT pruning.
 */
async function classifyChannelPublicness(
  channel: string,
): Promise<"public" | "non_public" | "unknown"> {
  try {
    const info = await slack.conversations.info({ channel });
    const c = info.channel;
    if (!c) return "unknown";
    if (isExtractableChannel(c)) return "public";
    // Distinguish "flags present and say non-public" from "flags
    // missing" — only a positive non-public reading justifies pruning.
    if (c.is_private === true || c.is_im === true || c.is_mpim === true) {
      return "non_public";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

// ── Extraction sweep (phase 2 of /api/cron/sweep) ─────────────────────

export interface KbSweepSummary {
  scanned: number;
  extracted: number;
  proposed: number;
  pruned: number;
  gaveUp: number;
  skipped: number;
}

async function writeKbState(
  channel: string,
  threadTs: string,
  state: KbThreadState,
): Promise<void> {
  await kv.set(kbStateKey(channel, threadTs), state, { ex: KB_STATE_TTL_SEC });
}

/**
 * Walk the kb-extract:index and run at most MAX_KB_EXTRACT_PER_SWEEP
 * extractions. Per-member failures are contained (the member stays
 * intact for the next sweep); the function itself never throws for a
 * member-level error, but the caller still wraps it — a KB failure
 * must never fail recovery (phase 1).
 */
export async function runKbExtractionSweep(
  rlog: RequestLogger,
): Promise<KbSweepSummary> {
  const summary: KbSweepSummary = {
    scanned: 0,
    extracted: 0,
    proposed: 0,
    pruned: 0,
    gaveUp: 0,
    skipped: 0,
  };

  // Bounded window (PR #139): ascending score = oldest activity first,
  // so the first KB_EXTRACT_SCAN_LIMIT members are the most-idle
  // threads — the extract/prune candidates. Never a full (0, -1) scan.
  const members = (await kv.zrange(
    KB_EXTRACT_INDEX_KEY,
    0,
    KB_EXTRACT_SCAN_LIMIT - 1,
  )) as string[];
  const now = Date.now();
  // conversations.info once per channel per sweep.
  const publicnessCache = new Map<string, "public" | "non_public" | "unknown">();

  for (const member of members) {
    summary.scanned++;
    try {
      const parsed = parseIndexMember(member);
      if (!parsed) {
        await kv.zrem(KB_EXTRACT_INDEX_KEY, member);
        rlog("kb_extract_pruned", { member: member.slice(0, 40), reason: "malformed" });
        summary.pruned++;
        continue;
      }
      const { channel, threadTs } = parsed;

      const lastActivityAt = await kv.zscore(KB_EXTRACT_INDEX_KEY, member);
      if (lastActivityAt === null) continue; // removed by a racer — skip

      const state = await kv.get<KbThreadState>(kbStateKey(channel, threadTs));
      const action = decideKbExtraction(state, lastActivityAt, now);

      if (action === "wait") continue;

      if (action === "prune") {
        await kv.zrem(KB_EXTRACT_INDEX_KEY, member);
        rlog("kb_extract_pruned", { channel, threadTs, reason: "quiet_period_consumed" });
        summary.pruned++;
        continue;
      }

      if (action === "give_up") {
        await writeKbState(channel, threadTs, {
          status: "gave_up",
          extractedAt: now,
          attempt: state?.attempt ?? MAX_KB_EXTRACTION_ATTEMPTS,
          proposedHashes: state?.proposedHashes ?? [],
        });
        await kv.zrem(KB_EXTRACT_INDEX_KEY, member);
        rlog("kb_extraction_gave_up", {
          channel,
          threadTs,
          attempt: state?.attempt ?? null,
        });
        summary.gaveUp++;
        continue;
      }

      // action === "extract"
      if (summary.extracted >= MAX_KB_EXTRACT_PER_SWEEP) {
        // Budget spent — leave the member for the next sweep.
        summary.skipped++;
        continue;
      }

      // Channel publicness — FAIL CLOSED (#136): extraction only runs
      // when the channel is positively confirmed public.
      let publicness = publicnessCache.get(channel);
      if (!publicness) {
        publicness = await classifyChannelPublicness(channel);
        publicnessCache.set(channel, publicness);
      }
      if (publicness !== "public") {
        if (publicness === "non_public") {
          // Confirmed private/DM/MPIM — never extractable; drop it.
          await kv.zrem(KB_EXTRACT_INDEX_KEY, member);
          summary.pruned++;
        } else {
          summary.skipped++;
        }
        rlog("kb_extraction_skipped", {
          reason: "private_channel",
          confirmed: publicness === "non_public",
          channel,
          threadTs,
        });
        continue;
      }

      const claimed = await acquireKbExtractClaim(channel, threadTs, rlog.requestId);
      if (!claimed) {
        rlog("kb_extract_claim_lost", { channel, threadTs });
        continue;
      }

      // ── Pre-checks inside the claimed section ─────────────────────
      // Idle re-check: the score may have moved between the scan and
      // the claim (a user replied). Re-read and re-decide.
      const freshActivityAt = await kv.zscore(KB_EXTRACT_INDEX_KEY, member);
      if (
        freshActivityAt === null ||
        decideKbExtraction(state, freshActivityAt, Date.now()) !== "extract"
      ) {
        rlog("kb_extraction_skipped", { reason: "idle_recheck", channel, threadTs });
        summary.skipped++;
        continue;
      }
      // A pending 👎-correction owns this thread's next reply — the
      // explicit correction flow outranks passive learning.
      const pendingCorrection = await kv.get(
        `pending-correction:${channel}:${threadTs}`,
      );
      if (pendingCorrection) {
        rlog("kb_extraction_skipped", { reason: "pending_correction", channel, threadTs });
        summary.skipped++;
        continue;
      }
      // An unconfirmed KB proposal already sits in this thread.
      const pendingBatch = await kv.get<string>(
        kbBatchThreadPointerKey(channel, threadTs),
      );
      if (pendingBatch) {
        rlog("kb_extraction_skipped", { reason: "pending_kb_batch", channel, threadTs });
        summary.skipped++;
        continue;
      }

      // ── Extract ───────────────────────────────────────────────────
      const priorHashes = state?.proposedHashes ?? [];
      const botId = await getBotUserId();
      // Paginated tail (PR #139): fetchThreadMessages caps at 50
      // unpaginated, below the 60-message extraction window — the tail
      // helper follows next_cursor and keeps the most recent messages.
      const threadMsgs = await fetchThreadTail(
        channel,
        threadTs,
        MAX_EXTRACTION_MESSAGES,
      );
      const { rendered, entries } = buildExtractionTranscript(threadMsgs, botId ?? "");

      if (entries.length === 0) {
        // Nothing to learn from — mark the quiet period covered.
        await writeKbState(channel, threadTs, {
          status: "covered",
          extractedAt: Date.now(),
          attempt: 0,
          proposedHashes: priorHashes,
        });
        rlog("kb_extraction_skipped", { reason: "empty_thread", channel, threadTs });
        summary.skipped++;
        continue;
      }

      summary.extracted++;
      const candidates = await extractKbCandidates({ transcript: rendered }, { log: rlog });

      if (candidates === null) {
        // Failure — extractKbCandidates already logged the reason.
        // Attempt resets on a gave_up re-arm (new activity), so a
        // gave_up state counts as attempt 0 here.
        const attempt = (state?.status === "gave_up" ? 0 : state?.attempt ?? 0) + 1;
        await writeKbState(channel, threadTs, {
          status: "failed",
          extractedAt: Date.now(),
          attempt,
          proposedHashes: priorHashes,
        });
        continue;
      }

      // ── Gate ──────────────────────────────────────────────────────
      const visibleKb = await getAllKnowledge();
      const { eligible, dropped } = gateKbCandidates({
        candidates,
        transcript: entries,
        visibleKb,
        alreadyProposedHashes: priorHashes,
      });
      rlog("kb_candidates_gated", {
        channel,
        threadTs,
        candidateCount: candidates.length,
        eligibleCount: eligible.length,
        droppedCount: dropped.length,
        dropReasons: dropped.map((d) => d.reason),
      });

      if (eligible.length === 0) {
        await writeKbState(channel, threadTs, {
          status: "covered",
          extractedAt: Date.now(),
          attempt: 0,
          proposedHashes: priorHashes,
        });
        continue;
      }

      // ── Propose (post → record → state; K-P ordering) ─────────────
      // The proposal post itself must NOT bump kb-extract:index — we
      // post via replyInThread directly, never through the turn runner.
      const message = formatKbProposalMessage(eligible);
      const firstTs = await replyInThread(channel, threadTs, message);
      if (!firstTs) {
        // Post failed silently — treat as a failed attempt.
        const attempt = (state?.status === "gave_up" ? 0 : state?.attempt ?? 0) + 1;
        await writeKbState(channel, threadTs, {
          status: "failed",
          extractedAt: Date.now(),
          attempt,
          proposedHashes: priorHashes,
        });
        continue;
      }

      const record: PendingKbBatch = {
        candidates: eligible,
        proposedAt: Date.now(),
        channel,
        threadTs,
        messageFirstTs: firstTs,
      };
      await kv.set(kbBatchKey(channel, firstTs), record, { ex: KB_BATCH_TTL_SEC });
      await kv.set(kbBatchThreadPointerKey(channel, threadTs), firstTs, {
        ex: KB_BATCH_TTL_SEC,
      });

      await writeKbState(channel, threadTs, {
        status: "covered",
        extractedAt: Date.now(),
        attempt: 0,
        // Recorded at PROPOSAL time so an ignored (unconfirmed)
        // proposal is never re-proposed in a later quiet period.
        proposedHashes: [...new Set([...priorHashes, ...eligible.map((c) => c.hash)])],
      });

      rlog("kb_batch_proposed", {
        count: eligible.length,
        channel,
        threadTs,
        firstTs,
        kinds: eligible.map((c) => c.kind),
        sampleEntries: eligible.slice(0, 3).map((c) => c.entry.slice(0, 80)),
      });
      summary.proposed++;
    } catch (err) {
      // One bad member must not abort the rest — and because the claim
      // is non-destructive, index + state stay recoverable BY DESIGN.
      rlog("kb_extract_member_failed", {
        member: member.slice(0, 60),
        errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
      Sentry.captureException(err, { tags: { flow: "kb_extract_sweep" } });
    }
  }

  rlog("kb_extract_sweep_complete", { ...summary });
  return summary;
}

// ── Confirmation: save a claimed batch ────────────────────────────────

/**
 * Atomically claim and execute a pending KB batch. Structural clone of
 * turn-runner.ts's executeBatchCreation protocol:
 *
 * get → atomic del claim (Redis DEL — only the first caller sees 1) →
 * tombstone → thread-pointer cleanup → Promise.allSettled saves →
 * summary post. Racing handlers (double ✅, ✅ + "confirm all") see
 * deleted === 0 and abort without writing to the KB.
 *
 * Correction-kind candidates run saveKnowledgeEntry then
 * markKnowledgeSuperseded for each flagged entry (#124 supersession).
 */
export async function executeKbBatchSave(
  channel: string,
  threadTs: string,
  firstTs: string,
  confirmingUser: string,
  confirmVia: "reaction" | "text",
  rlog: RequestLogger,
): Promise<{ claimed: boolean }> {
  const primaryKey = kbBatchKey(channel, firstTs);

  const batch = await kv.get<PendingKbBatch>(primaryKey);
  if (!batch) {
    return { claimed: false };
  }

  const deleted = await kv.del(primaryKey);
  if (deleted === 0) {
    rlog("kb_batch_claim_lost", { channel, firstTs, confirmVia });
    return { claimed: false };
  }

  // Tombstone the claim so a second ✅ on the same message returns
  // silently instead of falling anywhere else. There is NO text-parse
  // fallback for KB proposals (K-P4) — the tombstone only guards
  // duplicate user feedback, never a re-save.
  try {
    await kv.set(kbBatchTombstoneKey(channel, firstTs), 1, {
      ex: KB_BATCH_TOMBSTONE_TTL_SEC,
    });
  } catch {
    // Non-fatal; Sentry already captured via the kv wrapper.
  }

  // Best-effort cleanup of the thread pointer.
  try {
    await kv.del(kbBatchThreadPointerKey(channel, threadTs));
  } catch {
    // Non-fatal; Sentry already captured via the kv wrapper.
  }

  rlog("kb_batch_confirmed", {
    count: batch.candidates.length,
    confirmVia,
    confirmingUser,
    latencyMs: Date.now() - batch.proposedAt,
    channel,
    threadTs,
  });

  const saveStart = Date.now();
  const settled = await Promise.allSettled(
    batch.candidates.map(async (c) => {
      const id = await saveKnowledgeEntry(c.entry);
      let supersededCount = 0;
      if (c.kind === "correction") {
        // Best-effort retirement (PR #139): the entry IS durably saved
        // at this point — a KV flake while retiring flagged entries
        // must never reject this promise and misreport the save as a
        // failure. Mirrors the 👎 correction flow's semantics
        // (correction_supersede_error in turn-runner.ts). Worst case a
        // stale entry stays visible — observable via the count below.
        for (const flaggedText of c.flaggedKbEntries) {
          try {
            if (await markKnowledgeSuperseded(flaggedText, id)) {
              supersededCount++;
            }
          } catch (err) {
            rlog("kb_supersede_error", {
              channel,
              threadTs,
              entrySample: c.entry.slice(0, 80),
              flaggedSample: flaggedText.slice(0, 80),
              errorMessage:
                err instanceof Error ? err.message.slice(0, 200) : String(err),
            });
          }
        }
      }
      return { id, supersededCount };
    }),
  );

  const outcomes: KbSaveOutcome[] = settled.map((res, i) => {
    const candidate = batch.candidates[i];
    if (res.status === "fulfilled") {
      return {
        status: "saved",
        entry: candidate.entry,
        id: res.value.id,
        supersededCount: res.value.supersededCount,
      };
    }
    const errorMessage =
      res.reason instanceof Error ? res.reason.message : String(res.reason);
    Sentry.captureException(res.reason, {
      tags: { flow: "kb_save", batchSize: String(batch.candidates.length) },
      extra: { entrySample: candidate.entry.slice(0, 80) },
    });
    rlog("kb_save_error", {
      channel,
      threadTs,
      entrySample: candidate.entry.slice(0, 80),
      errorClass:
        res.reason instanceof Error ? res.reason.constructor.name : "Unknown",
      errorMessage: errorMessage.slice(0, 200),
    });
    return { status: "error", entry: candidate.entry, errorMessage };
  });

  // Append the batch hashes to the thread state (idempotent union —
  // proposal time already recorded them; this covers state records
  // that were rewritten in between). Best-effort.
  try {
    const state = await kv.get<KbThreadState>(kbStateKey(channel, threadTs));
    await writeKbState(channel, threadTs, {
      status: state?.status ?? "covered",
      extractedAt: state?.extractedAt ?? Date.now(),
      attempt: state?.attempt ?? 0,
      proposedHashes: [
        ...new Set([
          ...(state?.proposedHashes ?? []),
          ...batch.candidates.map((c) => c.hash),
        ]),
      ],
    });
  } catch {
    // Non-fatal — the gate's duplicate_kb rule still blocks re-proposal
    // of anything that actually saved.
  }

  const successCount = outcomes.filter((o) => o.status === "saved").length;
  rlog("kb_batch_saved", {
    totalCount: outcomes.length,
    successCount,
    failureCount: outcomes.length - successCount,
    supersededTotal: outcomes.reduce(
      (s, o) => s + (o.status === "saved" ? o.supersededCount : 0),
      0,
    ),
    durationMs: Date.now() - saveStart,
    channel,
    threadTs,
  });

  await replyInThread(channel, threadTs, summarizeKbSaveResult(outcomes));
  return { claimed: true };
}
