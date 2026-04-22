# Architecture

Battle Mage is a Slack agent that runs as a Next.js serverless function on Vercel. It receives webhook events from Slack, processes them with Claude AI and 9 GitHub tools (code search, file read, issues, PRs, commits, issue creation, knowledge base), and replies in-thread with cited references.

## High-Level Flow

```
Slack Event (webhook)
  |
  v
POST /api/slack (Next.js API route)
  |
  ├── Verify Slack signature (HMAC-SHA256)
  ├── Return 200 OK immediately (ack within 3 seconds)
  |
  └── after() — async processing continues after response
        |
        ├── Post thinking message ("Battle Mage is working...")
        ├── Run agent loop (Claude + tools)
        │     ├── Tool round 1: search_code("auth middleware")
        │     │   └── Update thinking message: "🔍 Searching for auth middleware..."
        │     ├── Tool round 2: read_file("src/middleware/auth.ts")
        │     │   └── Update thinking message: "📖 Reading src/middleware/auth.ts..."
        │     └── ... up to 15 rounds
        ├── Convert markdown to Slack mrkdwn
        ├── Format reference links
        └── Post final answer via `postReplyInChunks`
              ├── Split body into chunks (≤3K chars each)
              ├── Chunk 0: edit thinking message in place
              └── Chunks 1..N: post as new thread replies with "[continued ↓]"
```

## The Ack-Then-Process Pattern

Slack requires a `200 OK` response within 3 seconds. If the webhook handler takes longer, Slack retries the event (and eventually marks the app as unhealthy).

Battle Mage uses Next.js `after()` to ack the HTTP request immediately, then continue processing asynchronously. Vercel keeps the serverless function alive until the `after()` callback completes.

```typescript
export async function POST(request: NextRequest) {
  // ... verify signature, parse event ...

  // Return 200 immediately
  after(async () => {
    // This runs AFTER the response is sent
    // Claude + GitHub calls happen here
  });

  return NextResponse.json({ ok: true });
}
```

The route also rejects Slack retries by checking the `x-slack-retry-num` header. Since we already acked the first delivery, retries are duplicates.

## Webhook Event Handling

The `/api/slack` route handles four event types:

### `app_mention` -- Direct @mention

When a user types `@bm <question>`, Slack sends an `app_mention` event. The handler:

1. Strips the `<@BOT_ID>` mention from the message text
2. Posts a thinking message in the thread
3. Runs the agent loop with live progress updates
4. Deletes the thinking message
5. Posts the final answer with references

### `message` (thread reply) -- Follow-up without re-mention

When a user posts in a thread where the bot has already replied, Slack sends a `message` event. The handler:

1. Checks this is a thread reply (not a top-level message)
2. Skips messages that @mention the bot (those are handled by `app_mention`)
3. Checks if the bot has previously replied in this thread (via `conversations.replies`)
4. If yes, processes the message the same way as an `app_mention`

### `reaction_added` with `white_check_mark` -- Issue creation confirmation

When a user reacts with :white_check_mark: to a bot message containing an issue proposal:

1. Fetches the message text
2. Verifies it was posted by the bot (not by someone else)
3. Parses the proposal title, body, and labels from the message format
4. Creates the issue on GitHub via `octokit.rest.issues.create`
5. Replies with a link to the new issue

### `reaction_added` with `+1` or `-1` -- Feedback

**Thumbs up (+1)**:
1. Fetches the Q&A context stored in KV (question, answer summary, references)
2. Saves a positive feedback entry
3. Adds a :brain: reaction to acknowledge

**Thumbs down (-1)**:
1. Fetches the Q&A context
2. Saves a negative feedback entry
3. Runs auto-correction: identifies stale KB entries (keyword matching) and doc references
4. Removes stale KB entries from Vercel KV
5. Replies asking the user what was wrong

## System Prompt Assembly

The system prompt is assembled in two zones — a **stable zone** (cache-target, identical across turns in the same thread) followed by a **volatile zone** (per-turn data). Sections are wrapped in XML tags for model steerability and to let a future Anthropic `cache_control` breakpoint sit cleanly at the boundary.

The function `assembleSystemPrompt()` takes these inputs:

| Input | Source | Description | Zone |
|-------|--------|-------------|------|
| `owner` / `repo` | Environment variables | Target GitHub repository | both |
| `claudeMd` | `CLAUDE.md` in the target repo | Project-specific context (cached per cold start) | volatile |
| `knowledge` | Vercel KV | Knowledge base entries (corrections from users) | volatile |
| `feedback` | Vercel KV | Recent thumbs up/down feedback summaries | volatile |
| `repoIndex` | Vercel KV (lazy-rebuilt) | Auto-generated topic map of the repository | volatile |
| `pathAnnotations` | `.battle-mage.json` in target repo | Per-path trust annotations | volatile |

### Stable zone (XML-tagged, ordered)

1. `<identity>` — who the bot is (Battle Mage), where it runs (Slack), which repo it reads
2. `<core-principles>` — verify before asserting, cite specifically, thread-only, confirm issue creation
3. `<source-hierarchy>` — code > tests > docs > KB > feedback, with conflict-detection rules (see [Source Hierarchy](./features/source-hierarchy.md))
4. `<tools>` — canonical names of the 7 GitHub tools
5. `<search-strategy>` — budget tool rounds, repo map first, read 2–3 files max, synthesize early
6. `<knowledge-base-usage>` — when and how to save corrections via `save_knowledge`
7. `<output-contract>` — Slack mrkdwn format, anti-narration bans, brevity, recency (see below)

### Volatile zone (conditional, below the cache-breakpoint target)

- `<repo-context>` — owner + repo literals
- `## Project Context (from CLAUDE.md)` — the target repo's CLAUDE.md if present
- `## Repository Map (auto-generated index)` — the topic index if rebuilt
- `## Path Annotations (from .battle-mage.json)` — trust annotations if configured
- `## Knowledge Base (learned corrections)` — KB entries from Vercel KV if non-empty
- `## User Feedback (from 👍/👎 reactions)` — feedback summary if non-empty

Each volatile section is omitted when its data is null, so a fresh repo with no KB/feedback/index produces a compact prompt.

### Output contract (what makes replies Slack-native)

The `<output-contract>` block is the single most important piece of prompt engineering for response quality. It mandates:

- **Slack mrkdwn only** — `*bold*` (single asterisk), `_italic_`, `` `code` ``, `<url|text>` links. Bans `**double asterisks**`, `[text](url)` markdown links, `##` headings, and pipe-syntax tables.
- **Anti-narration** — explicit list of banned phrases the model must not emit: "let me check", "i'll look into this", "one moment", "fetching now", "hold on while i...", "looking into that...". Replies are single result-focused messages after tool work, not step-by-step narration.
- **Brevity** — direct answer in 2–3 sentences, target `MAX_ANSWER_LINES` (15), bullets over prose, no brochure/marketing copy.
- **Recency** — prefer activity within `RECENCY_WINDOW_DAYS` (30) from today; skip `docs/archive/` unless asked; flag data older than the window rather than presenting as current.

`MAX_ANSWER_LINES` and `RECENCY_WINDOW_DAYS` are exported constants from `src/lib/claude.ts`.

### Why the stable/volatile split

The zoning enables Anthropic prompt caching. A single `cache_control: {type: "ephemeral"}` breakpoint sits at the end of the stable zone, so the entire stable prompt is cached and served from cache on subsequent turns in the same thread (5-minute TTL). The volatile tail (KB, feedback, repo-index) changes per turn and stays outside the cache. XML tags also give the model stronger steering signals than plain-text headings.

### Prompt caching (active)

`assembleSystemBlocks()` returns an `Anthropic.TextBlockParam[]` rather than a plain string. The first block carries `cache_control: {type: "ephemeral"}` — Anthropic caches every block up through that marker. The second block (volatile data) has no cache_control and is processed uncached on every turn.

The `tools` array in `src/tools/index.ts` is similarly cached: the last tool (`save_knowledge`) carries the cache_control marker so all seven tool definitions cache together.

Cache metrics are logged in the `agent_complete` event per turn:

- `cache_read_tokens` — tokens served from cache (fast path)
- `cache_creation_tokens` — tokens written to cache on a miss
- `input_tokens` — uncached input (the volatile tail + messages)
- `output_tokens` — model output

A warm thread should see `cache_read_tokens` dominate after the first turn. A cold turn shows all input as `cache_creation_tokens` — expected on the first request and after any 5-minute idle period. Sonnet's minimum cacheable size is 1024 tokens; our stable zone is well above that.

## The Agent Loop

The agent loop is a Claude tool-use loop with a hard cap of 15 rounds. It is **non-streaming** — each round is a single `messages.create` call that returns the complete response before any tools run (see [Message Splitting](./features/message-splitting.md) for why streaming was removed):

```
for round in 0..MAX_TOOL_ROUNDS:
    response = await anthropic.messages.create(system, tools, messages)

    if response.stop_reason == "end_turn":
        return text + references

    for each tool_use block in response:
        fire onProgress callback (updates thinking message with tool status)
        result = executeTool(name, input)
        collect references from result

    append tool results to messages

if loop exhausted:
    return "hit maximum tool calls" message
```

Progress updates run via `onProgress(toolName, input)` → `progressThrottle.update(...)` (`createThrottledUpdater` in `src/lib/slack-throttle.ts`). The throttle coalesces bursts of parallel tool progress into ~1 Slack edit every 1.2 seconds, well under Slack's rate limit. A final `progressThrottle.flush()` drains any pending update before the final answer is posted, preventing a stale progress message from overwriting the answer.

### Model tiering — main vs fast (see #75)

Battle Mage uses two Anthropic models:

- **`MODEL = "claude-sonnet-4-6"`** — the main agent. All tool-use reasoning, synthesis, and answer generation run on Sonnet. Everything that the user sees is produced by this model.
- **`FAST_MODEL = "claude-haiku-4-5-20251001"`** — side tasks where Sonnet would be overkill. Today: **thread-history compaction**. Future candidates: thread title generation, LLM-based topic classification.

Rule: tasks that face the user directly or require multi-step reasoning stay on Sonnet. Tasks that are one-shot, summarization-shaped, or high-volume low-nuance classification go to Haiku. Haiku is ~5× cheaper and ~2× faster for this shape of work; the quality drop on summarization is imperceptible.

Every per-call log (`agent_start`, `agent_complete`, `agent_api_error`, `thread_compacted`) includes a `model` field so you can audit which tier ran which call from Sentry.

### Thread-history compaction (see #76)

Long threads (Slack Q&A with the bot accumulating over many follow-ups) used to replay the entire conversation on every turn — growing token cost and diluting the model's focus on the *current* question. Now we compact when the conversation grows past a character threshold:

- **Trigger:** `THREAD_COMPACTION_TRIGGER_CHARS = 60_000` (≈15k tokens) AND more than `MIN_PRESERVED_TURNS = 6` turns of history exist.
- **Action:** oldest turns are summarized and the summary is embedded as leading context INSIDE the first preserved user turn, prefixed with `[Conversation summary — earlier turns condensed]`. This preserves Anthropic's "first message must be role=user" invariant without needing a synthetic assistant turn. The remaining preserved turns are verbatim so local context (references to "that file we read", etc.) stays intact.
- **Model:** Haiku 4.5 (`FAST_MODEL`). Runs a single non-streaming `messages.create` with a summarization prompt.
- **Fail-safe:** if the compactor throws (rate limit, Haiku down), `compactThread` returns the original history and logs `thread_compaction_error`. The agent still runs — uncompacted, which is expensive but correct.
- **One-shot, not rolling.** Junior's reference implementation uses rolling compaction (up to 16 layers). For battle-mage's QA-shaped threads, one compaction is sufficient; we'll revisit if we ever see a thread that trips the trigger twice.

Integration point: `runAgent` in `src/lib/claude.ts`. Single check at the top of the function, before the round loop. Covers both mention-follow-up and thread-follow-up flows because both path through `runAgent`.

### Answer delivery — split, don't truncate

The final answer flows through `postReplyInChunks` in `src/lib/slack.ts`, which splits long bodies into multiple thread replies instead of truncating them to fit Slack's 40K-char limit. Each chunk is a complete, valid Slack message well under the limit; users see the same logical answer across 1-4 posts depending on length. See [Message Splitting](./features/message-splitting.md) for the full design.

### One-answer lifecycle

The thinking message is created once and **reused as chunk 0** of the final answer — no delete-and-repost flicker on short answers. Sequence:

1. Post thinking message: "🧠 Battle Mage is working…"
2. Tool rounds: emoji + status via `onProgress` → throttled `updateMessage(thinkingTs, ...)`
3. `runAgent` returns; `progressThrottle.flush()` drains pending progress edits
4. Build final body: formatted text + references footer (and proposal block if present)
5. `postReplyInChunks({ channel, threadTs, thinkingTs, text: finalBody })`:
   - Splits `finalBody` into N chunks at paragraph boundaries (see [Message Splitting](./features/message-splitting.md))
   - Chunk 0: `updateMessage(thinkingTs, chunks[0])` — edits the thinking message in place
   - Chunks 1..N: `replyInThread(channel, threadTs, chunks[i])` — new thread posts
   - Returns `{ firstTs, chunks }`
6. Store Q&A context using `firstTs` (chunk 0's ts)

The `finally` block still deletes the thinking message as a safety net if the turn crashed before any chunk posted (`thinkingTs` is only cleared once a chunk was successfully sent).

### Other key behaviors

- **References are collected from tool results**, not from Claude's text. Each tool that accesses a file or issue returns structured `Reference` objects with labels, URLs, and types (`file`, `doc`, `issue`, `pr`, `commit`).
- **References are ranked** by the source-of-truth hierarchy before display: code files first, then tests, then cited refs, then docs, then uncited list results. This is done by `rankReferences()` in `references.ts`.
- **References are deduplicated** by label (case-insensitive) during formatting and **capped at 7**.
- **Issue proposals are extracted** from `create_issue` tool calls and attached to the result separately. They are formatted with a confirmation prompt in the Slack message.

## Tool System

Seven tools are registered with Claude's tool-use API:

| Tool | GitHub API | Returns References? |
|------|-----------|-------------------|
| `search_code` | `search.code` | No (discovery only) |
| `read_file` | `repos.getContent` | Yes — typed as `file` or `doc` |
| `list_issues` | `issues.listForRepo` / `issues.get` | Yes — typed as `issue`, includes title |
| `list_commits` | `repos.listCommits` | Yes — typed as `commit`, includes SHA + message |
| `list_prs` | `pulls.list` | Yes — typed as `pr`, includes number + title |
| `create_issue` | None (proposal only) | No |
| `save_knowledge` | None (Vercel KV) | No |

The tool registry is in `src/tools/index.ts`. Each tool is a separate file that exports:
- A `Tool` definition (name, description, input schema) for Claude's API
- An execute function that calls the GitHub API and formats the result

## Markdown to Slack mrkdwn Conversion

Claude generates standard Markdown, but Slack uses its own "mrkdwn" format. The `toSlackMrkdwn()` function converts:

- `## Heading` becomes `*Heading*` (Slack bold on its own line)
- `**bold**` becomes `*bold*` (Slack uses single asterisks)

This runs on every response before posting to Slack. Without it, users would see literal `##` and `**` characters.

> **Known limitation**: The converter does not handle headings inside code blocks. A `## comment` inside triple backticks will be converted to `*comment*`. This rarely matters in practice since code blocks are fenced with triple backticks which Slack handles natively.

## Reference Formatting and Ranking

Every bot answer includes a footer with links to the sources that were accessed, ranked by trustworthiness:

```
───
*References:*
  • 📄 src/middleware/auth.ts
  • 📄 tests/auth.test.ts
  • 🎫 #1446 Replace supervisor with s6-overlay
  • 📖 docs/deployment/setup.md
_React with 👍 or 👎 to help me give better answers in the future._
```

### Type labels

Each reference has a type with an emoji prefix:

| Emoji | Type | Meaning |
|-------|------|---------|
| 📄 | `file` | Source code file the agent read |
| 📖 | `doc` | Documentation file (.md or docs/) |
| 🎫 | `issue` | GitHub issue (includes title) |
| 🔀 | `pr` | Pull request (includes title) |
| 📜 | `commit` | Commit (includes SHA + message) |

### Ranking

References are sorted by `rankReferences()` to mirror the source-of-truth hierarchy:

| Tier | Score | Type | Rationale |
|------|-------|------|-----------|
| 1 | 50 | Source code files | Code is truth |
| 2 | 40 | Test files | Encode expected behavior |
| — | +20 | Any ref cited in answer | Agent explicitly mentioned it |
| 4 | 10 | Documentation | Can drift from reality |
| 5 | 0 | Uncited list results | Discovery artifacts |

This ensures users see the most authoritative sources first.

### Other behaviors

- **Deduplicated** by label (case-insensitive, first occurrence wins)
- **Capped at 7** -- fewer but higher-quality links
- **Search results excluded** -- `search_code` does not generate references (discovery only)
- **Feedback hint** appended after every answer's references

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Webhook mode, not Socket mode** | Vercel serverless functions cannot maintain persistent WebSocket connections. Webhook mode works naturally with serverless. |
| **Ack-then-process** | Slack requires 200 OK within 3 seconds. The API route acks immediately, then processes via `after()`. |
| **Thread-only replies** | The bot never posts at channel root. All responses go in the thread where it was mentioned. Keeps channels clean. |
| **Verify before asserting** | The agent uses GitHub tools to check that files and methods actually exist before referencing them. No hallucinated code references. |
| **Issue creation requires confirmation** | The bot proposes issues but never creates them without explicit :white_check_mark: reaction. Prevents accidental issue spam. |
| **Search first, read second** | The system prompt instructs Claude to search for code patterns before reading files. A single search returns multiple paths with context, avoiding blind file reads. |
| **15 tool round budget** | Hard cap prevents runaway tool loops. The system prompt instructs Claude to synthesize early rather than exhausting all rounds. |
| **References from reads only** | Search results are discovery aids and do not appear in references. Only files the agent actually reads (via `read_file`) are cited. |
| **KV for knowledge, not GitHub** | The knowledge base lives in Vercel KV, not in the GitHub repo. The GitHub PAT does not need Contents: Write permission. |
| **Split long answers, don't truncate** | Answers over ~3K chars post as multiple thread replies (`[continued ↓]`) instead of being silently cut off. Makes Slack's `msg_too_long` architecturally unreachable on the happy path. See [Message Splitting](./features/message-splitting.md). |
| **Thinking message reused as chunk 0** | The "🧠 Battle Mage is working…" message is edited in place with the first chunk of the answer — no delete-and-repost flicker. Subsequent chunks post as new thread replies. |

## Project Structure

```
src/
  app/
    api/slack/route.ts    -- Webhook handler (mention, reaction, thread follow-up)
    page.tsx              -- Landing page
    layout.tsx            -- Root layout
  lib/
    slack.ts              -- Slack client, signature verification, message helpers
    claude.ts             -- Anthropic client, system prompt assembly, agent loop
    github.ts             -- Octokit client (search, read, issues, PRs, commits, tree)
    knowledge.ts          -- Knowledge base (Vercel KV sorted set)
    feedback.ts           -- Feedback storage (Vercel KV) and Q&A context
    repo-index.ts         -- Repository topic index (lazy rebuild on SHA change)
    auto-correct.ts       -- Stale KB entry detection and doc reference flagging
    progress.ts           -- Progress message formatter (tool name to emoji + status)
    mrkdwn.ts             -- Markdown to Slack mrkdwn converter
    references.ts         -- Reference deduplication, capping, and formatting
    split-reply.ts        -- Pure splitter for long Slack replies (paragraph/line/word/fence-aware)
  tools/
    index.ts              -- Tool registry and executor
    search-code.ts        -- GitHub code search
    read-file.ts          -- GitHub file/directory read
    list-issues.ts        -- GitHub issue list and lookup
    list-commits.ts       -- Recent commits on main
    list-prs.ts           -- Recent pull requests
    create-issue.ts       -- Issue proposal drafting and message parsing
    save-knowledge.ts     -- Knowledge base save (Vercel KV)
```
