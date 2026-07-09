# Battle Mage (@bm)

A Slack agent with Claude AI intelligence and full GitHub repo access — reads code, docs, issues, PRs, and commits. Creates issues on request. Invoke via `@bm` in Slack.

## Architecture

- **Runtime**: Vercel (Next.js serverless functions)
- **Slack**: Webhook mode via Next.js API route (`/api/slack`), ack-then-process via `after()`
- **AI**: Anthropic Claude API with tool use (8 tools, adaptive per-turn round budget: quick 4 / standard 10 / deep 15)
- **GitHub**: Octokit REST API (fine-grained PAT, read-only for code/PRs, read-write for issues)
- **Knowledge**: Upstash Redis (Vercel Marketplace — corrections, feedback, repo index cache) + Upstash Vector (semantic recall for KB + docs + source code, graceful lexical-only degradation)
- **Context**: CLAUDE.md + KB + feedback + repo index + source hierarchy + search strategy + recency/brevity rules
- **Progress**: Live thinking messages with contextual emoji, reused in place as the first chunk of the answer
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

7. **Passive KB learning is proposal-only** — After a thread goes quiet (4h), the cron sweep's second phase extracts KB candidates from the transcript with a fast model. Every candidate must cite human evidence (verified by a deterministic non-LLM gate), extraction only runs in positively-confirmed PUBLIC channels (fail closed), and NOTHING writes to the KB without an explicit ✅ / "confirm all" — the same confirmation-before-write principle as issue creation. See `docs/features/passive-kb-learning.md`.

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
    knowledge.ts          — Knowledge base (Upstash Redis sorted set)
    feedback.ts           — Feedback storage (Upstash Redis) and Q&A context
    issue-batch.ts        — Pure helpers for multi-proposal formatting and bulk-confirm matching
    effort-routing.ts     — Turn classifier (follow-up shouldReply gate + effort buckets → round/answer budgets)
    idempotency.ts        — Content-addressed idempotent execution (issue creation, #125)
    recovery.ts           — Processing markers + sweep decisions for died turns (#125)
    turn-runner.ts        — Mention/follow-up turn bodies (shared by webhook route + sweep)
    compaction.ts         — Thread-history compaction (Haiku one-shot summary inside first preserved turn)
    thread-filter.ts      — Pure follow-up gating + multi-turn history building from Slack threads
    slack-throttle.ts     — Coalesces progress updates (~1 Slack edit / 1.2 s, serialized flushes)
    slack-users.ts        — Slack user ID → display name resolution with KV caching
    time-budget.ts        — Per-turn wall-clock budget (warn at 80%, force-stop at 100%)
    topic-match.ts        — Question → repo-index topic pre-matching (injects starting paths)
    path-filter.ts        — Excludes tooling/metadata paths from search, reads, and indexing
    api-error.ts          — Anthropic API error classification + user-facing messages
    reply-footer.ts       — Opt-in telemetry footer for replies (BM_REPLY_FOOTER=1)
    kb-extract.ts         — Passive-KB transcript rendering + fast-model extractor (#136)
    kb-gate.ts            — Deterministic provenance gate for passive KB candidates (pure)
    kb-proposals.ts       — Pure passive-KB lifecycle helpers (KV keys, idle decision, formatters)
    kb-runner.ts          — Passive-KB orchestration (sweep phase 2, activity index, batch save)
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
    save-knowledge.ts     — Knowledge base save (Upstash Redis)
  evals/
    behavior/
      harness/            — Record/replay harness: cassette hashing, contracts, fakes, scenario runner
      scenarios/          — Full-turn behavior scenarios (run via npm run eval:behavior, NOT npm test)
      cassettes/          — Committed recordings (one JSON per scenario; replay is keyless)
docs/
  setup.md                — Complete setup guide (Slack, GitHub, Vercel, KV)
  usage.md                — How to use the bot day-to-day
  architecture.md         — How the internals work (agent loop, prompt, tools)
  contributing.md         — Contributing guide (TDD, CI, fork workflow)
  troubleshooting.md      — Common issues and fixes
  observability.md        — Structured JSON logs, Sentry integration, event catalog
  evals.md                — Judge-lite output-contract rubric harness
  features/
    repo-index.md         — Lazy-rebuilt topic map (KV-cached)
    knowledge-base.md     — Upstash Redis knowledge base (supersession lifecycle, top-k recall)
    source-hierarchy.md   — Source-of-truth hierarchy (5 levels)
    auto-correction.md    — Auto-correction on 👎 reactions
    progress-ux.md        — Live progress updates (emoji + status)
    message-splitting.md  — Long-reply chunking architecture (split-reply + boundary guard)
    issue-creation.md     — Batch issue proposals + bulk-confirm flow
    config.md             — .battle-mage.json path annotations (graduated trust)
    effort-routing.md     — Fast-model follow-up gate + per-turn effort budgets
    hybrid-retrieval.md   — Lexical + semantic retrieval (Upstash Vector, RRF fusion, degradation)
    code-index.md         — Incremental semantic code index (manifest cursor, cron tick, src arm)
    passive-kb-learning.md — Evidence-cited passive KB proposals (sweep phase 2, confirm-before-write)
    behavior-evals.md     — Record/replay behavior evals (cassettes, contracts, keyless CI)
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

Behavior evals (full-turn contracts, record/replay — see `docs/features/behavior-evals.md`):

```bash
npm run eval:behavior         # Replay committed cassettes — keyless, deterministic
npm run eval:behavior:record  # Re-record against live APIs (local only; refuses under CI)
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
| `CRON_SECRET` | Bearer token for `/api/cron/*` (sweep + code-index; unset = deny all requests) |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis endpoint (Vercel Marketplace integration; legacy `KV_REST_API_*` also read) |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis token |
| `UPSTASH_VECTOR_REST_URL` | Optional — Upstash Vector index (built-in embedding model) for hybrid retrieval |
| `UPSTASH_VECTOR_REST_TOKEN` | Optional — Vector index token; unset pair degrades to lexical-only |
| `SENTRY_DSN` | Optional — overrides the hardcoded DSN for structured log capture (see `docs/observability.md`) |
