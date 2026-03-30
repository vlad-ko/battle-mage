# Battle Mage (@bm)

A Slack agent with Claude AI intelligence and GitHub repo access. Invoke via `@bm` in Slack to ask questions about your codebase.

## Architecture

- **Runtime**: Vercel (Next.js serverless functions)
- **Slack**: Webhook mode via Next.js API route (`/api/slack`)
- **AI**: Anthropic Claude API with tool use
- **GitHub**: Octokit REST API (fine-grained PAT)
- **Context**: Project CLAUDE.md + wizard reasoning framework

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

5. **Issue creation requires confirmation** — The agent can propose a GitHub issue but NEVER creates one without explicit ✅ reaction approval in Slack.

6. **Thread follow-ups** — Once the bot is participating in a thread, users can send follow-up messages without re-mentioning. The bot checks for its own prior replies before responding.

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
    create-issue.ts       — GitHub issue proposal + parser
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
