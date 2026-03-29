# Battle Mage (@bm)

A Slack agent powered by Claude AI that answers questions about your GitHub codebase. Mention `@bm` in any Slack channel to ask about code, architecture, issues, or PRs.

Built with the [Wizard](https://github.com/vlad-ko/claude-wizard) reasoning framework.

## Features

- **Code Intelligence** — Search code, read files, understand architecture
- **Issue Awareness** — List and read GitHub issues and PRs
- **Issue Creation** — Propose issues with confirmation before creating
- **Thread Context** — Responds in-thread, maintains conversation context
- **Verify-First** — Checks code exists before referencing it (no hallucinations)

## Quick Start

```bash
git clone https://github.com/vlad-ko/battle-mage.git
cd battle-mage
npm install
cp .env.example .env.local
# Fill in your Slack, Anthropic, and GitHub credentials
npm run dev
```

Then configure your Slack app's Event Subscription URL to `https://your-domain/api/slack`.

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/vlad-ko/battle-mage)

Set environment variables in Vercel dashboard (see `.env.example`).

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot User OAuth Token from Slack app |
| `SLACK_SIGNING_SECRET` | Yes | Signing Secret from Slack app |
| `ANTHROPIC_API_KEY` | Yes | API key from [Anthropic Console](https://console.anthropic.com) |
| `GITHUB_PAT` | Yes | Fine-grained PAT with repo read access |
| `GITHUB_OWNER` | Yes | GitHub org or username |
| `GITHUB_REPO` | Yes | Repository name |

## Slack App Setup

1. Create a new Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Event Subscriptions** with URL: `https://your-vercel-url/api/slack`
3. Subscribe to bot events: `app_mention`
4. Add OAuth scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`
5. Install to workspace and copy the Bot Token

## How It Works

```
User @mentions @bm in Slack
  → Vercel API route receives webhook
  → Acks within 3 seconds (Slack requirement)
  → Sends question to Claude with GitHub tools
  → Claude searches code, reads files as needed
  → Response posted back to Slack thread
```

## License

MIT
