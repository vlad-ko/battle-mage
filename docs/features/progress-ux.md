# Live Progress Updates

While Battle Mage processes a question, users see a live-updating status message in the thread. This provides visibility into what the bot is doing and reduces the perception of waiting.

## The Thinking Message Pattern

When the bot starts processing a question:

1. A "thinking" message is posted immediately in the thread
2. As each tool is called, the message is updated in place with a new status line
3. When the answer is ready, the thinking message is edited in place to become the first chunk of the final answer (reused as chunk 0 — no delete-and-repost flicker)
4. If the answer is long, the remaining chunks are posted as new thread replies

The user sees something like:

```
🧠 Battle Mage is working... (this may take a minute, go grab some tea)
🔍 Searching for "authentication middleware"...
```

Then a few seconds later:

```
🧠 Battle Mage is working... (this may take a minute, go grab some tea)
👓 Reading src/middleware/auth.ts...
```

Then the thinking message transforms into the final answer (the same Slack message, edited in place).

## Header + Status Line

The thinking message has two parts:

1. **Header** (fixed): `🧠 Battle Mage is working... _(this may take a minute, go grab some tea)_`
2. **Status line** (updates on each tool call): the contextual status

The header stays the same on every update. Only the status line changes. This prevents the message from "jumping" in the Slack UI, since the first line remains stable.

The `buildThinkingMessage()` function composes these two parts:

```typescript
function buildThinkingMessage(toolName: string, input: ToolInput): string {
  const status = formatProgressMessage(toolName, input);
  return `${HEADER}\n${status}`;
}
```

## Contextual Emoji Map

Each tool has its own emoji and message format:

| Tool / Step | Emoji | Example Message |
|-------------|-------|-----------------|
| `thinking` | 🧠 | _Thinking about your question..._ |
| `index` | 🗂️ | _Checking repo index..._ |
| `search_code` | 🔍 | _Searching for "authentication middleware"..._ |
| `search_repo` | 🧭 | _Searching code + docs for "message splitting"..._ |
| `read_file` | 👓 | _Reading src/middleware/auth.ts..._ |
| `list_issues` | 🎫 | _Looking up issues..._ |
| `list_commits` | 📜 | _Checking recent commits..._ |
| `list_prs` | 🔀 | _Checking recent PRs..._ |
| `create_issue` | 📝 | _Drafting issue proposal..._ |
| `save_knowledge` | 💾 | _Saving to knowledge base..._ |
| `composing` | ✏️ | _Composing answer..._ |
| (unknown) | 🧠 | _Working on it..._ |

All status messages are italicized using Slack's underscore syntax (`_text_`), which visually distinguishes them from actual answer text.

## Dynamic Content in Status Lines

Two tools include dynamic content from their input:

- **`search_code`** shows the search query: `🔍 _Searching for "authentication middleware"..._`
- **`read_file`** shows the file path: `👓 _Reading src/middleware/auth.ts..._`

Long file paths are truncated to 60 characters with a leading `...`:

```
👓 _Reading ...eeply/nested/directory/structure/that/goes/on/forever/file.php..._
```

Other tools show fixed messages since their inputs are less informative to the user.

## How Updates Are Delivered

The progress callback is passed to `runAgent()`:

```typescript
const result = await runAgent(cleanMessage, async (toolName, input) => {
  if (thinkingTs) {
    await updateMessage(channel, thinkingTs, buildThinkingMessage(toolName, input));
  }
});
```

Before each tool is executed, the callback fires. The route handler uses `updateMessage()` (which calls `slack.chat.update`) to edit the thinking message in place.

After the agent loop returns, the progress throttle is flushed (so no stale status overwrites the answer), and `postReplyInChunks` edits the thinking message in place with the first chunk of the final answer. Remaining chunks, if any, post as new thread replies (see [Message Splitting](./message-splitting.md)).

## Why Edit Instead of Delete-and-Repost?

The thinking message is reused as chunk 0 of the final answer rather than deleted and reposted:

1. No flicker — the message never disappears; users watching the thread see the status transform into the answer
2. The message timestamp (`ts`) is stable, so the Q&A context stored for 👍/👎 reactions keys off the same message users react to
3. It keeps the thread clean — one message carries both the progress phase and the answer

`deleteMessage()` still runs as a safety net in the `finally` block, but only if the turn crashed before any answer chunk was posted.

## Testing

The progress formatting is tested in `src/lib/progress.test.ts`. Tests cover:

- Each tool's emoji and message format
- All messages being italic (wrapped in underscores)
- Unknown tool names handled gracefully (fallback to brain emoji)
- Long file path truncation
- The header staying constant across different tools
- The header appearing on the first line of every built message
