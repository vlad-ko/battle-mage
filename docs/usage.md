# Usage Guide

Battle Mage is a Slack bot that answers questions about your GitHub codebase. Mention it with `@bm` to ask a question. It reads your code, searches for patterns, checks issues and PRs, and replies in-thread.

## Asking Questions

Mention the bot in any channel where it is installed:

```
@bm Where is the authentication middleware defined?
```

```
@bm What changed in the last week?
```

```
@bm How does the payment processing pipeline work?
```

The bot will:

1. Post a thinking message with live status updates
2. Search your codebase, read relevant files, and check issues/PRs
3. Delete the thinking message and post the final answer with reference links

All replies go in-thread. The bot never posts at channel root.

## Thread Follow-Ups

Once the bot has replied in a thread, you can send follow-up messages **without re-mentioning** it:

```
@bm How does user authentication work?
  [bot answers]

What about the password reset flow?
  [bot answers -- no @bm needed]

Can you show me the relevant tests?
  [bot answers]
```

The bot checks whether it has already replied in the thread. If it has, it treats any new message in that thread as a follow-up and responds automatically.

> **Tip**: This only works in threads where the bot has already posted. If you start a new thread, you need to @mention the bot again.

## What Kinds of Questions Work Well

Battle Mage has access to seven tools for exploring your codebase:

| Tool | What it does |
|------|-------------|
| `search_code` | Find functions, classes, patterns, keywords across the repo |
| `read_file` | Read file contents or list directory entries |
| `list_issues` | List open/closed issues, look up specific issues by number |
| `list_commits` | Show recent commits on main with dates |
| `list_prs` | Show recent PRs (open, merged, closed) with dates |
| `create_issue` | Propose a new GitHub issue (requires your confirmation) |
| `save_knowledge` | Save a correction to the persistent knowledge base |

**Good questions**:

- "Where is X defined?" -- the bot searches for X and reads the file
- "How does feature Y work?" -- the bot searches, reads relevant files, and explains
- "What's changed recently?" -- the bot checks commits, PRs, and issues
- "What's the status of issue #42?" -- the bot looks up the specific issue
- "What are the open bugs?" -- the bot lists issues filtered by labels
- "Show me the tests for the auth module" -- the bot searches for test files

**Less effective questions**:

- Extremely broad questions like "explain the entire codebase" -- the bot has a budget of 15 tool rounds per question, so it cannot read every file
- Questions about runtime behavior or logs -- the bot has read access to code, not production systems
- Questions about other repositories -- the bot is scoped to a single repo

> **Tip**: If the bot's answer is too shallow, ask a more specific follow-up. "How does the auth module work?" is broad. "How does the auth middleware validate JWT tokens?" is specific enough for the bot to find exactly the right code.

## Creating GitHub Issues

Ask the bot to create an issue:

```
@bm Can you file a bug for the login timeout on Safari?
```

The bot will draft a proposal with a title, body, and suggested labels. It will **not** create the issue immediately. Instead, you will see:

```
[analysis and context]

───────────────────
Proposed Issue: Fix login timeout on Safari
Labels: bug

[issue body with steps to reproduce, context, etc.]

React with :white_check_mark: to create this issue, or ignore to cancel.
```

To confirm, add a :white_check_mark: (checkmark) reaction to the bot's message. The bot will create the issue on GitHub and reply with a link:

```
:white_check_mark: Created issue #47: Fix login timeout on Safari
```

If you do not react, nothing happens. The proposal is discarded.

> **Why the confirmation step?** The bot should never create issues without explicit human approval. This prevents accidental issue spam and lets you review the proposed title and description first.

## Correcting the Bot

When the bot gets something wrong, you have two options:

### Option 1: Reply with the correction

Just tell the bot what was wrong in the thread:

```
@bm Where does the config file live?
  [bot says config/settings.php]

No, we moved that to config/app.php last month.
  [bot saves correction to knowledge base]
```

The bot uses the `save_knowledge` tool to persist the correction in Vercel KV. Future answers will include this correction in the system prompt.

### Option 2: Thumbs down and explain

React with :thumbsdown: to the bot's answer. The bot will:

1. Record negative feedback
2. Check for stale knowledge base entries related to the answer and remove them
3. Check if the answer referenced documentation files that may be outdated
4. Reply asking what was wrong

Then explain the issue in the thread, and the bot will save the correction.

## Feedback Reactions

React to any bot answer with:

- **:thumbsup:** -- The bot records positive feedback silently (adds a :brain: reaction to acknowledge). Over time, positive feedback helps the bot understand what answer style works well for your team.

- **:thumbsdown:** -- The bot takes corrective action (see above) and asks for more detail.

Feedback is stored in Vercel KV and injected into the system prompt. The bot sees a summary of what worked and what did not when composing future answers.

> **Note**: Feedback context expires after 7 days. If you react to a very old message, the bot will not have the Q&A context to process the feedback.

## Tips for Getting Better Answers

1. **Be specific**. "How does auth work?" is vague. "How does the JWT validation middleware handle expired tokens?" gives the bot a clear search target.

2. **Ask about code, not opinions**. The bot excels at "where is X?", "how does Y work?", and "what changed?". It is less useful for design advice or architecture opinions.

3. **Use follow-up threads**. Start broad, then narrow down. The bot handles multi-turn conversations naturally.

4. **Correct mistakes immediately**. The sooner you correct the bot, the sooner the knowledge base improves. Corrections persist across conversations.

5. **Watch the progress messages**. The thinking message shows what the bot is doing (searching for "auth middleware", reading `src/auth.ts`, etc.). If it is searching for the wrong thing, you can post a follow-up to redirect it.

6. **Leverage recency**. The bot is date-aware and prefers recent activity. Questions like "what shipped this week?" or "any new bugs?" work well because the bot checks commits, PRs, and issues with date context.

## Limitations

- **15 tool rounds per question**. The bot budgets its tool calls. For very complex questions, it may answer with partial information and suggest follow-ups.
- **Read-only GitHub access**. The bot can read code and create issues (with confirmation), but cannot push code, merge PRs, or modify files.
- **Single repository**. The bot is configured to read one repository. It cannot cross-reference multiple repos.
- **No runtime access**. The bot reads source code and GitHub metadata. It does not have access to logs, databases, or production environments.
- **Slack formatting**. The bot outputs Slack mrkdwn, which does not support GitHub-flavored markdown features like tables or task lists.
