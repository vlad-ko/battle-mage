# Knowledge Base

The knowledge base stores corrections and learned facts from Slack conversations. It persists across conversations and is injected into every system prompt, giving the bot a persistent memory that improves over time.

## Storage

The knowledge base uses Upstash Redis, provisioned via the Vercel Marketplace (post-#117; older deployments provisioned it as "Vercel KV"). Entries are stored in a sorted set with the key `knowledge:entries`, scored by Unix timestamp (newest first).

Each entry is a JSON string:

```json
{
  "id": "b4f7c2e1-...",
  "entry": "The auth module lives in app/Services/Auth, not app/Http/Auth",
  "timestamp": "2026-03-28"
}
```

Entries are never deleted when corrected — they carry lifecycle fields instead (#124):

- `supersededById` — set when a correction replaced this entry; points at the replacement's `id`
- `archivedAt` / `archivedReason` — set when an entry was soft-deleted with a reason

Entries with either marker are hidden from the prompt but preserved in the sorted set, so the history of what was believed and why it changed survives. Legacy entries written before ids existed still parse and can be superseded by matching their text.

Each entry is also embedded into an Upstash Vector namespace on save (best-effort — KV remains the source of truth), and retire flows delete the retired entry's vector. This powers semantic recall; see [Hybrid Retrieval](./hybrid-retrieval.md).

## How Entries Are Saved

### Via the `save_knowledge` Tool

When a user corrects the bot in a conversation, the bot uses the `save_knowledge` tool to persist the correction:

```text
User: @bm Where does the auth config live?
Bot:  It's in config/auth.php
User: No, we moved that to config/security.php last month
Bot:  [calls save_knowledge with "Auth config was moved from config/auth.php
       to config/security.php"] Thanks for the correction! I've saved that.
```

The system prompt instructs the bot to save corrections immediately when:

- A user corrects a specific fact ("no, that's in X not Y")
- A user shares insider knowledge ("we deprecated that endpoint last week")
- The bot discovers something that contradicts documentation
- A user says "remember this" or similar

### Via Auto-Correction on Thumbs Down

When a user reacts with :thumbsdown: and then replies with a correction, the flagged stale entries are **superseded** by the correction (hidden from the prompt, linked to their replacement). See [Auto-Correction](./auto-correction.md) for details.

## How Entries Flow Into the System Prompt

Since #127 the prompt carries **top-k recall, not a full dump**. Each turn, `getKnowledgeRecallAsMarkdown(question)` selects the `RECALL_TOP_K` (5) *visible* entries most relevant to the current question:

- **Small KB** (≤5 visible entries): all entries render — no retrieval runs, no vector call.
- **Larger KB**: a lexical arm (distinct question tokens matching entry text, ties broken toward newer entries) and a semantic arm (Upstash Vector similarity over the embedded entries) are fused with Reciprocal Rank Fusion plus a tiny freshness tie-breaker. Only ids present in the visible set fetched in the same call can surface — a retired entry's leftover embedding can never resurrect it.
- **No matches in either arm**: the newest 5 entries render as a fallback.
- **Vector layer unconfigured or degraded**: recall silently runs lexical-only.

See [Hybrid Retrieval](./hybrid-retrieval.md) for the fusion math and degradation matrix. This keeps the prompt bounded as the KB grows — 500 saved corrections still cost at most 5 lines per turn.

The selected entries are formatted as a timestamped list ending with a stale-context footer:

```text
- [2026-03-28] The auth module lives in app/Services/Auth, not app/Http/Auth
- [2026-03-27] API rate limit is 120 req/min, not 60
- [2026-03-25] The deploy pipeline uses Docker Alpine, not Ubuntu

_Treat these as possibly stale context. Current user instructions and repository evidence take priority._
```

This is injected into the system prompt under the heading "Knowledge Base (learned corrections)" with a staleness warning:

> These are corrections from the team stored in Vercel KV. They can become stale as the codebase evolves -- always verify against the actual code before trusting a KB entry.

This warning is critical. KB entries rank 4th in the [source-of-truth hierarchy](./source-hierarchy.md) -- below source code, tests, and documentation. The bot is instructed to flag discrepancies when a KB entry contradicts what it sees in the code.

## Writing Good KB Entries

The system prompt guides the bot to write entries as standalone facts, not conversation snippets:

**Good entries:**
- "The auth module lives in app/Services/Auth, not app/Http/Auth"
- "The API rate limit is 120 req/min, not 60"
- "The `UserService.sync()` method was deprecated in favor of `UserSync.run()`"

**Bad entries:**
- "User said auth is somewhere else"
- "The thing they asked about is different now"
- "See the conversation above"

Each entry should be self-contained -- readable and useful without any surrounding context.

## Viewing and Managing Entries

### Via the Upstash Data Browser

You can inspect and edit knowledge base entries directly from the Vercel dashboard:

1. Go to your project's **Storage** tab
2. Open your Upstash Redis resource (this opens the Upstash data browser)
3. Find the key `knowledge:entries`
4. Browse the sorted set members

### Via Code

The `knowledge.ts` module exports these functions:

| Function | Description |
|----------|-------------|
| `saveKnowledgeEntry(entry)` | Add a new entry; returns its id. Also embeds the entry into the KB vector namespace (best-effort) |
| `supersedeKnowledgeEntry(oldIdOrText, newText)` | Save a replacement and mark the old entry superseded by it (old vector deleted best-effort) |
| `markKnowledgeSuperseded(idOrText, newId)` | Mark an existing entry superseded by an already-saved entry (vector deleted best-effort) |
| `archiveKnowledgeEntry(idOrText, reason)` | Soft-delete an entry with a reason (vector deleted best-effort) |
| `getAllKnowledge()` | Get visible entries (not superseded/archived), newest first |
| `getKnowledgeHistory()` | Get every entry including superseded and archived, newest first |
| `getKnowledgeAsMarkdown()` | Format ALL visible entries as markdown (with stale-context footer) |
| `getKnowledgeRecallAsMarkdown(question)` | Format the top-5 entries relevant to the question (hybrid recall) — what the prompt uses per turn |

### Retiring a Stale Entry

If you need to retire a KB entry:

1. Let the auto-correction system handle it -- thumbs-down an answer that relied on stale KB data and reply with the correction; flagged entries are superseded by it automatically
2. Or call `archiveKnowledgeEntry(idOrText, reason)` to soft-delete with a reason
3. Deleting the raw member in the Upstash data browser still works but erases history -- prefer the lifecycle functions

## Graceful Degradation

If Upstash Redis is not configured (common during local development without KV credentials), `getKnowledgeRecallAsMarkdown()` (and `getKnowledgeAsMarkdown()`) catches the error silently and returns `null`. The bot works normally without a knowledge base -- it just does not have persistent memory. If only the *vector* layer is unconfigured, saves and recall still work — recall just runs lexical-only (see [Hybrid Retrieval](./hybrid-retrieval.md)).

The knowledge base section is simply omitted from the system prompt when there are no entries.

## Relationship to Feedback

The knowledge base and the feedback system are separate:

- **Knowledge base** stores factual corrections ("X lives in Y, not Z"). These are high-signal, specific, and actionable.
- **Feedback** stores thumbs up/down signals with question/answer context. These are lower-signal and used to calibrate tone and approach.

Both are stored in Upstash Redis but under different keys (`knowledge:entries` vs `feedback:entries`). Both are injected into the system prompt but with different headings and different trust levels.
