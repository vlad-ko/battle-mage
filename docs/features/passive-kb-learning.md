# Passive KB Learning (Evidence-Cited)

Sub-issue #136 of epic #128. The knowledge base historically only grew
through explicit saves (`save_knowledge` tool) and 👎-corrections.
Threads routinely surface durable facts that were never captured. This
feature closes that gap **without ever writing to the KB
automatically**: after a thread goes quiet, a fast-model extraction
pass proposes candidates, a deterministic provenance gate filters them,
and everything lands as a **proposal** the user must confirm — the same
confirmation-before-write principle as issue creation.

## The pipeline

```
answer posted ──▶ kb-extract:index bump (zset, score = Date.now())
                        │
        /api/cron/sweep phase 2 (every 5 min, after recovery)
                        │
       decideKbExtraction(state, lastActivityAt, now)
         wait │ prune │ give_up │ extract
                        │ extract (≤ 3 per sweep)
       publicness check (conversations.info, FAIL CLOSED)
                        │
       NX claim ─▶ pre-checks (idle re-check, pending-correction,
                        │       pending KB batch)
       buildExtractionTranscript ─▶ extractKbCandidates (Haiku, 10s cap)
                        │
       gateKbCandidates (deterministic, non-LLM)
                        │ eligible > 0
       proposal message ─▶ pending-kb-batch record ─▶ state covered
                        │
       user confirms (✅ reaction or "confirm all" text)
                        │
       executeKbBatchSave ─▶ saveKnowledgeEntry
                             (+ markKnowledgeSuperseded for corrections)
```

## Modules

| File | Role |
|------|------|
| `src/lib/kb-extract.ts` | Transcript rendering + fast-model extractor (injected-call idiom, never throws) |
| `src/lib/kb-gate.ts` | Pure provenance gate: evidence verification, dedup, channel eligibility |
| `src/lib/kb-proposals.ts` | Pure lifecycle helpers: KV keys, `decideKbExtraction`, message formatters |
| `src/lib/kb-runner.ts` | Orchestration: sweep phase 2, activity recording, batch save |

## Evidence citations (the core contract)

Every extractor candidate MUST cite transcript message indices as
evidence. The gate verifies the citations deterministically:

- `no_evidence` — empty citation list.
- `evidence_out_of_range` — **fail closed**: ONE fabricated index kills
  the whole candidate.
- `no_human_evidence` — every cited message was authored by the bot.
  The bot can never launder its own assertions into the KB; at least
  one cited message must come from a human.

The full drop-reason precedence (pinned by tests in `kb-gate.test.ts`):

```
empty_entry → entry_too_long (500 chars, inclusive pass) →
low_confidence (< 0.75; >= passes) → no_evidence →
evidence_out_of_range → no_human_evidence → already_saved_in_thread →
duplicate_kb → already_proposed
```

- `already_saved_in_thread` — the thread already contains a bot
  "`:white_check_mark: Saved to knowledge base:`" confirmation covering
  the candidate (`KB_SAVED_CONFIRMATION_PREFIX`, shared with
  turn-runner's correction reply; matched by normalized containment
  because the confirmation truncates to 100 chars).
- `duplicate_kb` — normalized equality OR containment in either
  direction against the **visible** KB set. Superseded/archived entries
  never block re-learning.
- `already_proposed` — the candidate's content hash
  (`kbCandidateHash` = sha256 of the normalized text) was proposed in a
  prior quiet period, or duplicates an earlier candidate in the same
  batch. Ignored (unconfirmed) proposals are never re-posted.

Correction-kind candidates additionally get `flaggedKbEntries` — the
visible KB entries they likely contradict (keyword-overlap match,
`matchContradictedEntries`). That's an **annotation**, never a drop: on
confirm, the save marks those entries superseded (#124 supersession).

## Trigger: sweep piggyback

There is no new cron. `/api/cron/sweep` runs the recovery pass (phase
1, #125) and then passive-KB extraction (phase 2) under its own
try/catch — a KB failure can never fail recovery.

- **Discovery**: zset `kb-extract:index`, member `channel:threadTs`
  (recovery's `indexMember` format), score = `Date.now()` at answer
  post. `recordKbThreadActivity` bumps it best-effort after every
  `answer_posted` (mention + follow-up, answer + proposal paths). The
  KB proposal post itself never bumps the index — the extractor's own
  output must not re-arm extraction.
- **Idle gate**: a thread is "concluded" after `KB_EXTRACT_IDLE_MS`
  (4h) of quiet. Strict `>` — and a FUTURE score (clock skew) always
  waits.
- **Budget**: at most `MAX_KB_EXTRACT_PER_SWEEP` (3) model calls per
  sweep; each capped at `KB_EXTRACTOR_TIMEOUT_MS` (10s).
- **Retries**: a failed extraction retries on later sweeps up to
  `MAX_KB_EXTRACTION_ATTEMPTS` (2), then gives up until new thread
  activity re-arms it (attempt counter resets).
- **State**: `kb-extract:state:{channel}:{threadTs}` (30d TTL) —
  `{status: covered|failed|gave_up, extractedAt, attempt,
  proposedHashes}`. `decideKbExtraction` is a pure function over
  (state, lastActivityAt, now).
- **Claim**: non-destructive `SET NX` on
  `kb-extract:claim:{channel}:{threadTs}` (120s TTL) — a structural
  clone of recovery's `acquireSweepClaim`. Index + state survive any
  post-claim failure.
- **Pre-checks inside the claim**: idle re-check (score re-read), skip
  if a `pending-correction` record owns the thread's next reply, skip
  if an unconfirmed KB batch already sits in the thread.

## Channel privacy (fail closed)

Extraction only runs in channels **positively confirmed public** via
`conversations.info` (once per channel per sweep). Private channels,
DMs, and MPIMs are pruned from the index; channels whose publicness
can't be confirmed (missing `channels:read` scope, API error) are
skipped and logged as `kb_extraction_skipped` / `private_channel`. See
the scope note in [setup.md](../setup.md).

## Proposal + confirmation

Proposals reuse the issue-batch machinery's shape without its anchors:

- `pending-kb-batch:{channel}:{firstTs}` (24h) — the batch record.
- `pending-kb-batch:thread:{channel}:{threadTs}` — pointer for
  "confirm all" text confirmation.
- `pending-kb-batch:done:{channel}:{firstTs}` (1h) — tombstone
  absorbing a double-tap ✅.

`formatKbProposalMessage` **never** contains issue-batch's
`SINGLE_PROPOSAL_ANCHOR` or `BATCH_PROPOSAL_HEADER`, so the legacy ✅
text parser can never mistake a KB proposal for an issue proposal —
and there is deliberately **no text-parse fallback** for KB proposals:
the KV record is the only path to a save. Write ordering is
post → record → state, so a partial failure degrades to a proposal the
user can't confirm, never a save the user didn't approve.

`executeKbBatchSave` clones `executeBatchCreation`'s claim protocol
(get → atomic `DEL` claim → tombstone → pointer cleanup →
`Promise.allSettled` saves → summary post). Correction-kind saves run
`saveKnowledgeEntry` then `markKnowledgeSuperseded` per flagged entry.

The ✅ handler chain in `route.ts` is: issue batch →
`executeKbBatchSave` → issue tombstone → KB tombstone (silent return)
→ legacy issue parser.

## Invariants

1. Nothing writes to the KB without explicit human confirmation.
2. Every stored candidate cites verifiable human evidence.
3. Extraction never runs against non-public conversations (fail
   closed).
4. No text-parse fallback for KB proposals — KV record or nothing.
5. A KB-side failure never breaks recovery (sweep phase isolation) or
   the reply flow (activity bumps are best-effort).
6. The extractor is untrusted: it can only ever produce proposal text,
   filtered by a deterministic gate.
7. One quiet period → at most one extraction; ignored proposals are
   never re-posted (`proposedHashes`).
8. The KB proposal post never re-arms its own thread for extraction.

## Telemetry

See the "Passive KB Events" section in
[../observability.md](../observability.md) for the full catalog:
`kb_extraction_complete`, `kb_extraction_error`,
`kb_extraction_skipped`, `kb_candidates_gated`, `kb_batch_proposed`,
`kb_batch_confirmed`, `kb_batch_saved`, `kb_save_error`,
`kb_extract_pruned`, `kb_extraction_gave_up`, `kb_extract_claim_lost`,
`kb_batch_claim_lost`, `kb_batch_reaction_after_claim`,
`kb_extract_member_failed`, `kb_extract_sweep_complete`,
`kb_extract_sweep_failed`, `kb_activity_record_failed`.
