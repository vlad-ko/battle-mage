# Battle Mage (@bm)

A Slack agent powered by Claude AI that answers questions about your GitHub codebase. Mention `@bm` in any Slack channel to ask about code, architecture, issues, or PRs.

## Features

- **Code Intelligence** — Search code, read files, understand architecture
- **Issue Awareness** — List and read GitHub issues and PRs
- **Issue Creation** — Propose issues; confirm with a ✅ reaction to create
- **Thread Conversations** — Follow-up in threads without re-mentioning the bot
- **Project Context** — Automatically loads your repo's CLAUDE.md into the agent's system prompt
- **Verify-First** — Checks code exists before referencing it (no hallucinations)

## Quick Start

```bash
git clone https://github.com/your-org/battle-mage.git
cd battle-mage
npm install
cp .env.example .env.local
# Fill in your Slack, Anthropic, and GitHub credentials
npm run dev
```

Then configure your Slack app's Event Subscription URL to `https://your-domain/api/slack`.

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/your-org/battle-mage)

Set environment variables in the Vercel dashboard (see `.env.example`).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Yes | Signing Secret from Slack app |
| `ANTHROPIC_API_KEY` | Yes | API key from [Anthropic Console](https://console.anthropic.com) |
| `GITHUB_PAT_BM` | Yes | Fine-grained PAT with repo access |
| `GITHUB_OWNER` | Yes | GitHub org or username |
| `GITHUB_REPO` | Yes | Repository name |

### GitHub PAT Permissions

Create a [fine-grained PAT](https://github.com/settings/tokens?type=beta) scoped to your target repo:

- **Contents**: Read
- **Issues**: Read & Write
- **Pull requests**: Read
- **Metadata**: Read

## Slack App Setup

Use the included `slack-app-manifest.yaml` for one-step setup:

1. Go to [api.slack.com/apps?new_app=1](https://api.slack.com/apps?new_app=1)
2. Choose **"From a manifest"** and paste `slack-app-manifest.yaml`
3. Install the app to your workspace
4. Copy the **Bot Token** and **Signing Secret** to your env vars
5. Update the Event Subscription URL to your Vercel domain after deploy

### Required Bot Scopes

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Receive @mentions |
| `reactions:read` | ✅ reaction for issue confirmation |
| `chat:write` | Post thread replies |
| `channels:history` | Read messages in public channels |
| `groups:history` | Read messages in private channels |

## How It Works

```
User @mentions @bm in Slack
  → Vercel API route receives webhook
  → Acks within 3 seconds (Slack requirement)
  → Posts "thinking..." indicator immediately
  → Sends question to Claude with GitHub tools
  → Claude searches code, reads files as needed
  → Response posted back to Slack thread

Follow-up messages in the same thread
  → Bot responds without needing another @mention

Issue creation
  → Bot proposes issue with title, body, labels
  → User reacts with ✅ to confirm
  → Bot creates the issue and posts the link
```

## Architecture

- **Runtime**: Vercel (Next.js serverless functions)
- **AI**: Anthropic Claude API with tool use
- **GitHub**: Octokit REST API
- **Slack**: Events API (webhook mode, not Socket mode)

### Key Design Decisions

1. **Webhook mode** — Vercel serverless can't maintain WebSocket connections. Webhook mode works naturally.
2. **Ack-then-process** — Returns 200 OK immediately, processes async via `after()`.
3. **Thread-only** — Never posts at channel root. All responses go in threads.
4. **Verify before asserting** — The agent checks that files and methods exist before citing them.
5. **Confirmation gate** — Issues are proposed, never silently created. ✅ reaction to confirm.

## Project Structure

```
src/
  app/
    api/slack/route.ts    — Slack webhook handler (mention, reaction, thread follow-up)
    page.tsx              — Landing page
  lib/
    slack.ts              — Slack client, signature verification, message helpers
    claude.ts             — Anthropic client, system prompt, agent loop
    github.ts             — Octokit client (search, read, issues, PRs)
  tools/
    search-code.ts        — GitHub code search tool
    read-file.ts          — GitHub file read tool
    list-issues.ts        — GitHub issue list/lookup tool
    create-issue.ts       — GitHub issue proposal tool
```

## License

MIT
