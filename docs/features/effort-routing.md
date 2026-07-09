# Adaptive Effort Routing

Two per-turn decisions, one cheap Haiku call (see #126):

1. **shouldReply** — is a thread follow-up actually addressed to the bot? The old heuristic (bot has a prior reply in the thread) made the bot answer human-to-human chatter. Now a fast-model classifier reads the recent transcript and the new message and gates the reply.
2. **effort** — bucket the question into `quick | standard | deep`, sizing the agent's tool-round budget and answer-length target so trivial questions stop costing 15 rounds and hard ones stop being squeezed into a 3K-char answer.

All logic lives in `src/lib/effort-routing.ts`; the Slack route (`src/app/api/slack/route.ts`) composes it.

## The classifier call

`classifyTurn(input, deps)` makes **one** structured call on `FAST_MODEL` (Haiku, `max_tokens: 256`) with `TURN_CLASSIFIER_PROMPT` — a reviewed exported constant with `<INVOCATION>` / `<TRANSCRIPT>` / `<QUESTION>` slots. The model returns exactly:

```json
{"shouldReply": true, "shouldReplyConfidence": 0.92, "effort": "quick", "effortConfidence": 0.85}
```

- The transcript slot is filled by `extractTranscriptTail(messages, botUserId)` (`src/lib/thread-filter.ts`): the last 6 thread entries, mention-stripped, 500 chars max each, labeled `bot:` / `user:`.
- The call is capped at `CLASSIFIER_TIMEOUT_MS = 3000` via `Promise.race`.
- `classifyTurn` **never throws**. API errors, timeouts, unparseable output, and shape violations (missing keys, unknown bucket, confidences outside `[0, 1]` — rejected, never clamped) all return `null` and log `turn_classifier_error` with a stable `reason`.
- Dependency injection mirrors `compaction.ts`: `ClassifyDeps { call?, log? }`, so every branch is unit-testable without network.

## Decisions and thresholds

`CONFIDENCE_THRESHOLD = 0.75`, compared with `>=`. Two pure sync interpreters consume the (possibly null) verdict:

| Function | Verdict null / below threshold | Confident verdict |
|----------|-------------------------------|-------------------|
| `decideShouldReply` | **fail closed** → `false` (stay silent) | `shouldReply` as classified |
| `decideEffort` | **fail open** → `"standard"` (today's behavior) | bucket as classified |

The asymmetry is deliberate: a wrongly-silent bot costs one re-mention; a wrongly-chatty bot poisons the channel. A broken effort classifier, by contrast, must never degrade an answer — so it degrades to the standard budget instead.

### Fail-closed matrix (follow-up gate)

| Classifier outcome | `turn_classifier_error` reason | Reply? |
|--------------------|-------------------------------|--------|
| API error / sync throw | `api_error` | No |
| Over 3s | `timeout` | No |
| Non-JSON output | `malformed_json` | No |
| Missing key, bad bucket, confidence out of `[0,1]` or NaN | `invalid_shape` | No |
| `shouldReply: false` (any confidence) | — | No |
| `shouldReply: true`, confidence `< 0.75` | — | No |
| `shouldReply: true`, confidence `>= 0.75` | — | **Yes** |

## Effort tiers → budgets

`EFFORT_BUDGETS` in `effort-routing.ts` (imports `MAX_TOOL_ROUNDS` / `ANSWER_BUDGET_CHARS` from `claude.ts` — never the reverse):

| Bucket | maxRounds | answerCharsTarget |
|--------|-----------|-------------------|
| `quick` | 4 | 1,200 |
| `standard` | 10 | 3,000 (`ANSWER_BUDGET_CHARS`) |
| `deep` | 15 (`MAX_TOOL_ROUNDS`) | 6,000 |

Two delivery mechanisms:

- **Round cap** — the route passes `{ maxRounds, effort }` as `runAgent`'s optional 6th parameter. `resolveMaxRounds` (pure, exported from `claude.ts`) floors, clamps to `[1, MAX_TOOL_ROUNDS]`, and defaults to `MAX_TOOL_ROUNDS` when absent — so `claude.ts` never trusts a raw number and stays classifier-agnostic.
- **Answer-length steering** — `buildEffortHint(effort)` is appended to the **user message** (like `buildQuestionHints`), never the system prompt: the stable prompt zone stays byte-identical so prompt caching keeps hitting. For `standard` the hint is `""` — the default path is byte-for-byte unchanged.

## Route wiring

- **Mention path** (`app_mention`): `classifyTurn` runs with `invocation: "mention"` in a `Promise.all` with the topic fetch, and **shouldReply is never consulted** — an explicit @mention always gets an answer. Only `decideEffort` is used.
- **Follow-up path** (`message` in a bot thread): after the structural checks (bot-in-thread, not addressed to another user) and AFTER the pending-correction / bulk-confirm branches short-circuit, `evaluateFollowup` runs **before** the thinking message is posted. A decline produces **zero Slack writes** — just a `followup_reply_declined` log event (`reason`: `not_addressed` | `low_confidence` | `classifier_unavailable`) and a silent return.

## Observability

| Event | Fields |
|-------|--------|
| `turn_classified` | invocation, shouldReply, shouldReplyConfidence, effort, effortConfidence, duration_ms, model |
| `turn_classifier_error` | reason (`api_error` \| `timeout` \| `malformed_json` \| `invalid_shape`), message, duration_ms, model |
| `followup_reply_declined` | reason, confidence, channel, threadTs |
| `agent_start` / `agent_complete` | now carry `effort` + `max_rounds` — join with token fields to measure spend per bucket |

## Testing

- Unit tests: `src/lib/effort-routing.test.ts` (every fail-closed branch, threshold edges, prompt shape), `src/lib/thread-filter.test.ts` (`extractTranscriptTail`), `src/lib/claude.test.ts` (`resolveMaxRounds`).
- Eval fixtures: `src/evals/fixtures/should-reply.test.ts` runs representative transcripts against the real classifier — `npm run eval` only, never `npm test`.
