# Issue Creation

Battle Mage can propose GitHub issues and — on user confirmation — file them. Proposals never turn into real issues automatically; the user must approve first.

## Single vs. batch proposals

The agent uses the `create_issue` tool to propose an issue. A single turn can emit **one or many** proposals:

- **Single proposal** — the familiar "Proposed Issue:" block with title, labels, and full body inlined.
- **Batch proposal (N > 1)** — a compact numbered list of titles with inline labels, no inlined bodies.

**Both** cases persist a record in KV and accept the same two approval paths: a :white_check_mark: reaction on the proposal message, OR a short thread reply matched by `isBulkConfirmText` ("yes", "confirm", "confirm all", "create all", "go ahead", "approve all", etc.). The UX footer shown to users surfaces only the reaction path for N=1 to match the pre-#122 style, but the code path is identical to the N>1 case — any valid bulk-confirm phrase in the thread also works.

Bodies are persisted in KV so the confirmation path can create issues without round-tripping the full body through Slack message text.

## Flow

1. **User asks** — e.g. "file bugs for the 8 issues you found."
2. **Agent proposes** — the model calls `create_issue` once per proposed issue in the same turn. All proposals flow through `executeToolsInParallel` and land in `AgentResult.issueProposals` in order.
3. **Slack route renders** — `formatBatchProposalMessage(proposals)` produces the Slack mrkdwn block:
   - `proposals.length === 1` → legacy single-proposal format (unchanged UX)
   - `proposals.length >= 2` → batch format (numbered list + bulk-confirm footer)
4. **Batch persisted in KV**. Keys involved across the whole lifecycle:
   - `pending-issue-batch:{channel}:{firstTs}` — the canonical record (proposals, timing, requester, thread). 24 h TTL.
   - `pending-issue-batch:thread:{channel}:{threadTs}` — pointer to `firstTs` for text-command lookup. 24 h TTL.
   - `pending-issue-batch:done:{channel}:{firstTs}` — tombstone written on successful claim, 1 h TTL. Any subsequent ✅ reaction on the same message checks this key and exits silently — without it, a double-tap would fall through to the legacy parser (N=1 messages still have a body in their text).
   - `idem:issue:<sha256>` — per-issue idempotency record (#125), written at creation time. Content-addressed over `{title, body, labels}` (`labels: undefined` hashes identically to `[]`, order-insensitive). Held as a `pending` lock (60 s TTL) while `createIssue` runs, then replaced by a `completed` record carrying the issue number/URL (30-day TTL).
5. **User confirms** via one of:
   - :white_check_mark: reaction on the proposal message — reaction handler calls `executeBatchCreation`
   - `"confirm all"` (or synonym) in the thread — thread-followup handler calls `executeBatchCreation`
6. **Atomic claim** — `executeBatchCreation` reads the canonical key, then `kv.del`s it. Redis DEL is atomic: only the first caller sees `deleted === 1`; racing reactions/texts see `0` and bail. This serializes *batch* claims; the per-issue idempotency layer below catches anything that slips past it (Slack redelivery, legacy-parser re-entry, tombstone expiry).
7. **Idempotent parallel creation** via `Promise.allSettled` — every `createIssue` call is wrapped in `executeIdempotent(issueIdempotencyKey(p), ...)`:
   - `created` — fresh GitHub issue → success in the summary.
   - `replayed` — an identical proposal was already created within 30 days → success in the summary, reusing the **recorded** URL. No second GitHub issue.
   - `in_flight` — another confirmation holds the pending lock for this exact proposal right now → error-shaped outcome ("already being created by another confirmation").
   - KV outage → fail open: the issue is created unguarded and `idempotency_degraded` is logged. A rare duplicate beats a broken confirmation flow.
   Per-issue failures do not abort the rest, and a failed create releases its idempotency lock so a later confirmation can retry.
8. **Summary reply** from `summarizeBatchResult(outcomes)` — lists created issues with links and any failures with error messages.

## Bulk-confirm text matching

`isBulkConfirmText(text)` is intentionally strict to avoid accidentally creating issues during normal conversation:

- **Max 6 words** after whitespace/punctuation normalization.
- **Allowlist** of short phrases: `yes`, `yes please`, `confirm`, `confirm all`, `create all`, `create them all`, `go ahead`, `approve all`, plus common variants.
- **Disqualifier tokens** (`no`, `don't`, `only`, `just`, `this`, `#<digit>`, `issue`) reject the match even if an allowlist phrase is present. `"yes it failed"` and `"create this one"` correctly do not match.
- Only fires when there is a pending batch in the thread. Without a pending batch, bulk-confirm phrases fall through to the normal agent flow.

## Observability

Lifecycle events (structured logs; same shape as `kv_op`):

| Event | When | Key fields |
|---|---|---|
| `issue_batch_proposed` | After posting a proposal message | `count`, `sampleTitles`, `requestingUser`, `threadTs` |
| `issue_batch_confirmed` | Claim succeeded | `count`, `confirmVia` (`"reaction"` \| `"text"`), `latencyMs` |
| `issue_batch_claim_lost` | Claim raced another handler | `channel`, `firstTs`, `confirmVia` |
| `issue_batch_reaction_after_claim` | ✅ arrived after a successful claim (tombstone hit) | `channel`, `messageTs` |
| `issue_batch_created` | After all creations settle | `totalCount`, `successCount`, `failureCount`, `durationMs`, `numbers` |
| `issue_create_error` | Per-issue failure | `title`, `errorClass`, `errorMessage` |
| `idempotency_replayed` | Duplicate creation suppressed — recorded result returned | `key` |
| `idempotency_in_flight` | Concurrent creation of the same proposal detected | `key` |
| `idempotency_degraded` | KV unavailable — creation ran unguarded (fail open) | `key`, `phase` (`lock`/`unlock`/`record`), `errorMessage` |
| `issue_create_in_flight` | Legacy-parser path hit an in-flight lock and stayed silent | `via`, `channel`, `messageTs` |
| `webhook_handler_failed` | Unhandled error in the ✅ reaction handler | `flow: "reaction_checkmark"`, `message` |

Per-issue failures also emit `Sentry.captureException` tagged `{flow: "issue_create", batchSize: <N>}` so a rate-limit burst on one title surfaces as a distinct Sentry issue rather than hiding under the summary. See `TELEMETRY.md` for the cross-feature event vocabulary and query recipes (including the duplicate-suppression rate).

## Edge cases

- **Multi-chunk proposal messages** — the canonical record is keyed by the first chunk's ts. If a proposal splits across chunks (rare — batch mode is compact by design; single mode is under the 4 k body budget), a reaction on a later chunk will not find the batch and will fall through to the legacy parser for single-proposal back-compat.
- **Racing confirmations** — two users react simultaneously, or one reacts while another types "confirm all". Two independent layers prevent double-creation: (1) the atomic `kv.del` claim ensures exactly one `executeBatchCreation` call proceeds — the loser logs `issue_batch_claim_lost` and exits silently; (2) even if a duplicate slips past the claim (Slack event redelivery, tombstone expiry followed by a legacy-parser fallback), the per-issue idempotency key replays the recorded issue (`idempotency_replayed`) or detects an in-flight creation (`idempotency_in_flight`) instead of filing a second GitHub issue.
- **Partial GitHub failures** — a rate limit or permission error on one title does not abort the rest. The summary reply lists every created issue AND every failure.
- **Legacy single-proposal messages** — pre-#122 messages have no KV record. The reaction handler falls back to `parseProposalFromMessage` and creates exactly one issue. Natural drain via 24 h TTL.

## Recovery sweep

Issue-creating turns run inside `after()` callbacks, and Vercel can kill the container mid-turn (timeout, OOM, platform restart). Since #125:

- Every mention/follow-up turn writes a **processing marker** (`processing:{channel}:{threadTs}`, indexed in the `processing:index` zset) as the **first step of the `after()` body**, and clears it in the `after()` `finally`. Only container death leaves a marker behind. The write is deliberately kept **off the ack path** — two KV round-trips before the 200 OK could breach Slack's 3-second deadline and trigger duplicate retries; the accepted trade is that a container death in the tiny window between the ack and the marker write loses recovery for that turn.
- A **cron sweep** (`/api/cron/sweep`, scheduled every 5 minutes via `vercel.json`) walks the index. A marker older than 15 minutes is provably dead (the route's `maxDuration` is 300 s): a first-attempt marker is **retried once** through the same turn-runner code path — after an already-answered guard so a turn that died between posting its answer and clearing its marker isn't double-answered — and a marker whose retry also died gets a **visible failure notice** in the thread ("I hit an error processing your question — please re-ask").
- Before acting on a stale marker, the sweep wins a **non-destructive claim**: `SET NX` on `processing:claim:{channel}:{threadTs}` with a 120 s TTL (`SWEEP_CLAIM_TTL_SEC`). A concurrent sweep loses NX and skips (`recovery_sweep_claim_lost`). The marker and index entry are cleared **only after the chosen action completes** — the give-up notice is posted *before* any deletion, and a retry *overwrites* the marker key in place — so a Slack failure mid-action leaves the turn recoverable by the next sweep once the claim TTL expires.
- The sweep's retry can safely re-reach `executeBatchCreation`/`createIssue` because of the idempotency layer above — a re-run of a turn that already created issues replays them instead of duplicating.

The sweep's cadence is correctness-independent: a slower schedule (e.g. Vercel Hobby's ~daily cron floor) only delays recovery, never breaks it.

## Code layout

- `src/lib/issue-batch.ts` — pure helpers (`formatBatchProposalMessage`, `isBulkConfirmText`, `summarizeBatchResult`). No I/O; safe to import in tests.
- `src/lib/idempotency.ts` — content-addressed idempotency (`issueIdempotencyKey`, `executeIdempotent`). See #125.
- `src/lib/turn-runner.ts` — `PendingIssueBatch` shape, KV key helpers, `executeBatchCreation`, and the mention/follow-up turn bodies (shared by the webhook route and the recovery sweep).
- `src/app/api/slack/route.ts` — the three entry points (mention → propose, thread text → confirm, reaction → confirm) plus processing-marker lifecycle.
- `src/app/api/cron/sweep/route.ts` — the recovery sweep (see `src/lib/recovery.ts` for the marker/staleness model).
- `src/tools/create-issue.ts` — `create_issue` tool schema and `parseProposalFromMessage` (legacy fallback).

See #122 for the original motivation and design discussion, #125 for idempotency + recovery.
