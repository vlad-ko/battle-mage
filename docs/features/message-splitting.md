# Message Splitting

Slack's `chat.postMessage` and `chat.update` APIs reject any `text` above 40,000 characters with a `msg_too_long` error. Battle Mage answers long questions by **splitting the reply across multiple thread posts**, not by truncating a single message. This makes the limit architecturally unreachable on the happy path and, when anything does approach it, fails loudly with a Sentry-captured stack instead of silently eating the user's answer.

## Invariant

**40K is only meaningful at the outbound guard; everything upstream keeps us 10-20× below it.**

The system has three layers that collaborate:

| Layer | File | Purpose |
|---|---|---|
| 1. Prompt output contract | `src/lib/claude.ts` | Tell the model to target ~3K chars; warn longer answers WILL be split |
| 2. Pure splitter | `src/lib/split-reply.ts` | Chop oversized replies at paragraph/line/word boundaries; fence-aware |
| 3. Fail-loud boundary guard | `src/lib/slack.ts` | Throw `SlackMessageOversizeError` if any chunk reaches the wire >40K — would indicate a splitter bug |

## Layer 1 — Output contract

Constants in `src/lib/claude.ts`:

- `ANSWER_BUDGET_CHARS = 3_000` — target for the main answer
- `ISSUE_PROPOSAL_BODY_BUDGET_CHARS = 4_000` — target for `create_issue` proposals

These numbers are stamped into the system prompt so the model steers toward compact replies:

> Target ~3,000 characters (≈60 lines) for your answer. Answers longer than the budget WILL be split across multiple thread replies automatically. That works, but a user absorbs one compact post much better than three long ones. Prefer concision.

Comparative / "summarize our X" questions are explicitly called out as **not an exception** — they are where the model most often over-writes. The contract also directs it to prefer references over inline content ("summarize the 3-5 key points, then point the user at specific files/PRs/issues").

## Layer 2 — The splitter

`splitSlackReplyText(text, { maxChars = 3000, maxLines = 60 }): string[]` in `src/lib/split-reply.ts`.

Pure function. No I/O. Fully unit-tested (`split-reply.test.ts`, 22 cases).

### Cut priority at each chunk boundary

1. Paragraph boundary (`\n\n`) at or before the char budget
2. Line boundary (`\n`)
3. Word boundary (` `)
4. Hard cut — with a surrogate-pair guard so a 4-byte emoji never gets split mid-code-point

The splitter falls through the priority list until it finds a cut point; step 4 is a last resort that preserves valid UTF-16.

### Continuation markers

Intermediate (non-final) chunks are suffixed with `_[continued ↓]_` so the user knows more is coming. The marker's chars and newlines are **reserved from the budget** before the cut is picked — appending it can never push a chunk back over the limit.

**Visual polish**: in the exact 2-chunk case the marker is dropped from chunk 0. A user scanning two replies in succession doesn't need the hint that chunk 1 exists right below.

### Code fences

If a cut lands inside a ` ``` ` or `~~~` code block, the splitter:

1. Closes the fence at the end of chunk N (adds a matching ` ``` ` line)
2. Re-opens the fence at the start of chunk N+1 with the same language tag

So a 4,000-line Python file fragment splits cleanly into multiple chunks, each with a valid, syntax-highlightable ` ```python ` block. Tilde fences (`~~~`) are handled identically.

### Line budget

Independent of the char budget. If a chunk has more than 60 lines, it splits even if char budget has room. Short many-line content (tables, lists) would otherwise produce very tall single posts.

## Layer 3 — Boundary guard

`requireSlackMessageText(text, action)` in `src/lib/slack.ts` throws `SlackMessageOversizeError` if `text.length > SLACK_MESSAGE_CHAR_LIMIT` (40,000).

Every outbound Slack call (`replyInThread`, `updateMessage`) runs this guard first. The expectation is that the splitter keeps us 10× below the limit; the guard's job is to make it loud if anything ever slips through. The thrown error carries a readable action label (e.g. `"chat.update"`) so Sentry captures a stack pointing at our frame, not a minified Slack SDK frame.

**Silent truncation is forbidden.** Earlier iterations (#93, #110, #111) tried progressively fancier truncators. Each silently ate the tail of the user's answer — including, in the worst case, the `:white_check_mark: to approve` call-to-action on issue-proposal messages. The guard replaces that behavior with fail-loud + split.

## Layer 4 — Multi-post delivery

`postReplyInChunks({ channel, threadTs, thinkingTs?, text })` in `src/lib/slack.ts` is the single entry point the Slack route uses for final answers and issue proposals:

1. Calls `splitSlackReplyText(text)` to produce `chunks`
2. Chunk 0: edits the thinking message (`updateMessage(channel, thinkingTs, chunks[0])`) if a `thinkingTs` was provided, otherwise posts as a fresh thread reply
3. Chunks 1..N-1: posts each as a new thread reply via `replyInThread`
4. Returns `{ firstTs, chunks }`

The caller uses `firstTs` to store Q&A context for reactions. `chunks` is logged in `answer_posted` so production visibility shows the split-rate distribution.

**Empty-input safety:** if the agent produced no text at all (`text.trim() === ""`), `splitSlackReplyText` returns `[]` and `postReplyInChunks` returns `{ firstTs: undefined, chunks: 0 }`. The route only clears `thinkingTs` when `chunks > 0`, so the `finally` block still deletes the stuck "thinking…" message.

## Tuning knobs

All defaults live in `src/lib/claude.ts` (prompt) and `src/lib/split-reply.ts` (splitter). To change behavior:

| Knob | Default | Effect |
|---|---|---|
| `ANSWER_BUDGET_CHARS` | 3,000 | Lower → more splits on borderline answers; raise → longer single posts |
| `ISSUE_PROPOSAL_BODY_BUDGET_CHARS` | 4,000 | Same, for proposal bodies |
| `DEFAULT_MAX_CHARS` | 3,000 | Splitter's chunk cap; should track `ANSWER_BUDGET_CHARS` |
| `DEFAULT_MAX_LINES` | 60 | Line budget per chunk (protects tall lists/tables) |
| `CONTINUATION_MARKER` | `\n\n_[continued ↓]_` | The intermediate-chunk marker text |
| `SLACK_MESSAGE_CHAR_LIMIT` | 40,000 | Outbound guard; should match Slack's actual limit |

## Observability

- `answer_posted` log event includes `chunks: N` — in prod, you can bucket by chunk count to see the distribution. `chunks: 1` should dominate; `chunks: ≥5` is unusual and worth investigating (possibly a tool-result leak into the final answer).
- `SlackMessageOversizeError` throws land in Sentry tagged `flow=mention` or `flow=thread_followup`. An occurrence means the splitter has a bug — widen the test matrix rather than raising the limit.

## History

- **#93** — first msg_too_long fix: capped tool-result sizes going INTO the agent (still in place, prevents the Anthropic-side context-window crash). Not related to outbound Slack posting.
- **#110** — first outbound char cap (39,500 chars). Silent truncation. Still hit `msg_too_long` on unicode-heavy content.
- **#111** — byte-based cap (36,000 UTF-8 bytes). Also silent. Still hit `msg_too_long` after merge — confirming truncation was the wrong primitive.
- **#112 / #113** — this architecture. Shipped April 2026. Replaces truncation with splitting + fail-loud guard.
