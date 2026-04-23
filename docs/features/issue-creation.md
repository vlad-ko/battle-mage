# Issue Creation

Battle Mage can propose GitHub issues and — on user confirmation — file them. Proposals never turn into real issues automatically; the user must approve first.

## Single vs. batch proposals

The agent uses the `create_issue` tool to propose an issue. A single turn can emit **one or many** proposals:

- **Single proposal** — the familiar "Proposed Issue:" block with title, labels, and full body inlined. Approved by a :white_check_mark: reaction on the message.
- **Batch proposal (N > 1)** — a compact numbered list of titles with inline labels, no inlined bodies. Approved by either a :white_check_mark: reaction on the message OR a short thread reply like "confirm all" / "yes" / "create all" / "go ahead" / "approve all".

Bodies are persisted in KV so the confirmation path can create issues without round-tripping the full body through Slack message text.

## Flow

1. **User asks** — e.g. "file bugs for the 8 issues you found."
2. **Agent proposes** — the model calls `create_issue` once per proposed issue in the same turn. All proposals flow through `executeToolsInParallel` and land in `AgentResult.issueProposals` in order.
3. **Slack route renders** — `formatBatchProposalMessage(proposals)` produces the Slack mrkdwn block:
   - `proposals.length === 1` → legacy single-proposal format (unchanged UX)
   - `proposals.length >= 2` → batch format (numbered list + bulk-confirm footer)
4. **Batch persisted in KV** under two keys:
   - `pending-issue-batch:{channel}:{firstTs}` — the canonical record (proposals, timing, requester, thread)
   - `pending-issue-batch:thread:{channel}:{threadTs}` — pointer to `firstTs` for text-command lookup
   - Both with a 24 h TTL.
5. **User confirms** via one of:
   - :white_check_mark: reaction on the proposal message — reaction handler calls `executeBatchCreation`
   - `"confirm all"` (or synonym) in the thread — thread-followup handler calls `executeBatchCreation`
6. **Atomic claim** — `executeBatchCreation` reads the canonical key, then `kv.del`s it. Redis DEL is atomic: only the first caller sees `deleted === 1`; racing reactions/texts see `0` and bail. No double-creation.
7. **Parallel creation** via `Promise.allSettled` — per-issue failures do not abort the rest.
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
| `issue_batch_created` | After all creations settle | `totalCount`, `successCount`, `failureCount`, `durationMs`, `numbers` |
| `issue_create_error` | Per-issue failure | `title`, `errorClass`, `errorMessage` |

Per-issue failures also emit `Sentry.captureException` tagged `{flow: "issue_create", batchSize: <N>}` so a rate-limit burst on one title surfaces as a distinct Sentry issue rather than hiding under the summary.

## Edge cases

- **Multi-chunk proposal messages** — the canonical record is keyed by the first chunk's ts. If a proposal splits across chunks (rare — batch mode is compact by design; single mode is under the 4 k body budget), a reaction on a later chunk will not find the batch and will fall through to the legacy parser for single-proposal back-compat.
- **Racing confirmations** — two users react simultaneously, or one reacts while another types "confirm all". The atomic `kv.del` ensures exactly one `executeBatchCreation` call proceeds. The loser logs `issue_batch_claim_lost` and exits silently.
- **Partial GitHub failures** — a rate limit or permission error on one title does not abort the rest. The summary reply lists every created issue AND every failure.
- **Legacy single-proposal messages** — pre-#122 messages have no KV record. The reaction handler falls back to `parseProposalFromMessage` and creates exactly one issue. Natural drain via 24 h TTL.

## Code layout

- `src/lib/issue-batch.ts` — pure helpers (`formatBatchProposalMessage`, `isBulkConfirmText`, `summarizeBatchResult`). No I/O; safe to import in tests.
- `src/app/api/slack/route.ts` — `PendingIssueBatch` shape, KV key helpers, `executeBatchCreation`, and the three entry points (mention → propose, thread text → confirm, reaction → confirm).
- `src/tools/create-issue.ts` — `create_issue` tool schema and `parseProposalFromMessage` (legacy fallback).

See #122 for the original motivation and design discussion.
