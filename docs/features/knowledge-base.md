# Knowledge Base

The knowledge base stores corrections and learned facts from Slack conversations. It persists across conversations and is injected into every system prompt, giving the bot a persistent memory that improves over time.

## Storage

The knowledge base uses Vercel KV (Upstash Redis). Entries are stored in a sorted set with the key `knowledge:entries`, scored by Unix timestamp (newest first).

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

## How Entries Are Saved

### Via the `save_knowledge` Tool

When a user corrects the bot in a conversation, the bot uses the `save_knowledge` tool to persist the correction:

```
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

The function `getKnowledgeAsMarkdown()` fetches the *visible* entries (not superseded, not archived) from KV and formats them as a timestamped list ending with a stale-context footer:

```
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

### Via Vercel KV Browser

You can inspect and edit knowledge base entries directly in the Vercel dashboard:

1. Go to your project's **Storage** tab
2. Open the KV database
3. Find the key `knowledge:entries`
4. Browse the sorted set members

### Via Code

The `knowledge.ts` module exports these functions:

| Function | Description |
|----------|-------------|
| `saveKnowledgeEntry(entry)` | Add a new entry; returns its id |
| `supersedeKnowledgeEntry(oldIdOrText, newText)` | Save a replacement and mark the old entry superseded by it |
| `markKnowledgeSuperseded(idOrText, newId)` | Mark an existing entry superseded by an already-saved entry |
| `archiveKnowledgeEntry(idOrText, reason)` | Soft-delete an entry with a reason |
| `getAllKnowledge()` | Get visible entries (not superseded/archived), newest first |
| `getKnowledgeHistory()` | Get every entry including superseded and archived, newest first |
| `getKnowledgeAsMarkdown()` | Format visible entries as markdown (with stale-context footer) for the prompt |

### Retiring a Stale Entry

If you need to retire a KB entry:

1. Let the auto-correction system handle it -- thumbs-down an answer that relied on stale KB data and reply with the correction; flagged entries are superseded by it automatically
2. Or call `archiveKnowledgeEntry(idOrText, reason)` to soft-delete with a reason
3. Deleting the raw member in the Vercel KV browser still works but erases history -- prefer the lifecycle functions

## Graceful Degradation

If Vercel KV is not configured (common during local development without KV credentials), `getKnowledgeAsMarkdown()` catches the error silently and returns `null`. The bot works normally without a knowledge base -- it just does not have persistent memory.

The knowledge base section is simply omitted from the system prompt when there are no entries.

## Relationship to Feedback

The knowledge base and the feedback system are separate:

- **Knowledge base** stores factual corrections ("X lives in Y, not Z"). These are high-signal, specific, and actionable.
- **Feedback** stores thumbs up/down signals with question/answer context. These are lower-signal and used to calibrate tone and approach.

Both are stored in Vercel KV but under different keys (`knowledge:entries` vs `feedback:entries`). Both are injected into the system prompt but with different headings and different trust levels.
