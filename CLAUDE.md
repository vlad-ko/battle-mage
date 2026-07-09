# Battle Mage (@bm)

A Slack agent with Claude AI intelligence and full GitHub repo access — reads code, docs, issues, PRs, and commits. Creates issues on request. Invoke via `@bm` in Slack.

## Architecture

- **Runtime**: Vercel (Next.js serverless functions)
- **Slack**: Webhook mode via Next.js API route (`/api/slack`), ack-then-process via `after()`
- **AI**: Anthropic Claude API with tool use (8 tools, adaptive per-turn round budget: quick 4 / standard 10 / deep 15)
- **GitHub**: Octokit REST API (fine-grained PAT, read-only for code/PRs, read-write for issues)
- **Knowledge**: Vercel KV (corrections, feedback, repo index cache) + Upstash Vector (semantic recall for KB + docs + source code, graceful lexical-only degradation)
- **Context**: CLAUDE.md + KB + feedback + repo index + source hierarchy + search strategy + recency/brevity rules
- **Progress**: Live thinking messages with contextual emoji, deleted on answer
- **Formatting**: Markdown-to-Slack mrkdwn conversion, typed references with emoji (📄📖🎫🔀📜), ranked by source-of-truth hierarchy, capped at 7
- **Auto-correct**: Thumbs-down flags stale KB entries for user confirmation, stores pending correction state

## Development

```bash
npm install
cp .env.example .env.local  # Fill in credentials
npm run dev                  # http://localhost:3000
```

## Key Design Decisions

1. **Webhook mode, not Socket mode** — Vercel serverless functions can't maintain persistent WebSocket connections. Webhook mode works naturally with serverless.

2. **Ack-then-process pattern** — Slack requires 200 OK within 3 seconds. The API route acks immediately, then processes the Claude + GitHub calls asynchronously via `waitUntil()`.

3. **Thread-only replies** — The bot NEVER posts at channel root. All responses go in the thread where it was mentioned.

4. **Verify before asserting** — The agent uses GitHub tools to check that files, methods, and classes actually exist before referencing them. No hallucinated code references.

5. **Issue creation requires confirmation** — The agent can propose one or many GitHub issues in a single turn but NEVER creates any without explicit approval. Approval is either a ✅ reaction on the proposal message or a short thread reply like "confirm all" / "yes". See `docs/features/issue-creation.md`.

6. **Thread follow-ups** — Once the bot is participating in a thread, users can send follow-up messages without re-mentioning. The bot checks for its own prior replies, then a fast-model classifier decides whether the message is actually addressed to the bot — anything else (human-to-human chatter, classifier errors) fails closed to silence. See `docs/features/effort-routing.md`.

## Project Structure

```
src/
  app/
    api/slack/route.ts    — Slack webhook handler (mention, reaction, thread follow-up)
    api/cron/sweep/route.ts — Recovery sweep (retries turns killed mid-processing)
    api/cron/code-index/route.ts — Incremental code-index tick (embeds changed source files)
    page.tsx              — Landing page
  lib/
    slack.ts              — Slack client, signature verification, message helpers
    claude.ts             — Anthropic client, system prompt assembly, agent loop
    github.ts             — Octokit client (search, read, issues, PRs, commits, tree)
    knowledge.ts          — Knowledge base (Vercel KV sorted set)
    feedback.ts           — Feedback storage (Vercel KV) and Q&A context
    issue-batch.ts        — Pure helpers for multi-proposal formatting and bulk-confirm matching
    effort-routing.ts     — Turn classifier (follow-up shouldReply gate + effort buckets → round/answer budgets)
    idempotency.ts        — Content-addressed idempotent execution (issue creation, #125)
    recovery.ts           — Processing markers + sweep decisions for died turns (#125)
    turn-runner.ts        — Mention/follow-up turn bodies (shared by webhook route + sweep)
    config.ts             — .battle-mage.json loader (path annotations with graduated trust)
    repo-index.ts         — Repository topic index (lazy rebuild on SHA change)
    auto-correct.ts       — Stale KB entry detection and doc reference flagging
    progress.ts           — Progress message formatter (tool → emoji + status)
    mrkdwn.ts             — Markdown → Slack mrkdwn converter
    logger.ts             — Structured JSON logging with request correlation IDs
    references.ts         — Typed references: ranking, dedup, emoji formatting
    split-reply.ts        — Pure splitter for long Slack replies (paragraph/line/word/fence-aware)
    kv.ts                 — @upstash/redis wrapper with Sentry observability (kv_op + kv_error events)
    vector.ts             — @upstash/vector wrapper (non-throwing, vector_op/vector_error events, 2s timeout)
    retrieval.ts          — Pure hybrid-retrieval primitives (RRF fusion, semantic merge, age boost, lexical ranking)
    code-chunker.ts       — Pure source-file chunking + embed-eligibility predicate (#135)
    code-index.ts         — Incremental code-index tick: manifest diff, budgets, degradation (#135)
  tools/
    index.ts              — Tool registry and executor
    search-code.ts        — GitHub code search tool
    search-repo.ts        — Hybrid code + docs + src search (lexical + semantic, RRF-fused)
    read-file.ts          — GitHub file/directory read tool
    list-issues.ts        — GitHub issue list/lookup tool
    list-commits.ts       — Recent commits on main (with dates)
    list-prs.ts           — Recent pull requests (open/merged/closed)
    create-issue.ts       — GitHub issue proposal + parser
    save-knowledge.ts     — Knowledge base save (Vercel KV)
docs/
  setup.md                — Complete setup guide (Slack, GitHub, Vercel, KV)
  usage.md                — How to use the bot day-to-day
  architecture.md         — How the internals work (agent loop, prompt, tools)
  contributing.md         — Contributing guide (TDD, CI, fork workflow)
  troubleshooting.md      — Common issues and fixes
  features/
    repo-index.md         — Lazy-rebuilt topic map (KV-cached)
    knowledge-base.md     — Vercel KV knowledge base
    source-hierarchy.md   — Source-of-truth hierarchy (5 levels)
    auto-correction.md    — Auto-correction on 👎 reactions
    progress-ux.md        — Live progress updates (emoji + status)
    message-splitting.md  — Long-reply chunking architecture (split-reply + boundary guard)
    issue-creation.md     — Batch issue proposals + bulk-confirm flow
    effort-routing.md     — Fast-model follow-up gate + per-turn effort budgets
    hybrid-retrieval.md   — Lexical + semantic retrieval (Upstash Vector, RRF fusion, degradation)
    code-index.md         — Incremental semantic code index (manifest cursor, cron tick, src arm)
TELEMETRY.md              — Incident-response event vocabulary + Sentry query recipes
vercel.json               — Vercel Cron schedules (recovery sweep + code-index tick)
```

## Testing (TDD Required)

All new features must use test-driven development:

1. **RED** — Write failing tests first
2. **GREEN** — Implement minimum code to pass
3. **REFACTOR** — Clean up while keeping tests green

Rules:
- Test files colocated: `foo.ts` → `foo.test.ts`
- Tests run via `npm test` (Vitest)
- CI blocks merge on test failure (GitHub Actions)
- Extract pure functions for testability — keep side effects in the handler layer

```bash
npm test              # Run all tests once
npm run test:watch    # Watch mode for development
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack app signing secret |
| `ANTHROPIC_API_KEY` | Claude API key |
| `GITHUB_PAT_BM` | Fine-grained PAT for target repo |
| `GITHUB_OWNER` | GitHub org/user |
| `GITHUB_REPO` | Repository name |
| `CRON_SECRET` | Bearer token for `/api/cron/sweep` (unset = sweep denies all requests) |
| `UPSTASH_VECTOR_REST_URL` | Optional — Upstash Vector index (built-in embedding model) for hybrid retrieval |
| `UPSTASH_VECTOR_REST_TOKEN` | Optional — Vector index token; unset pair degrades to lexical-only |
