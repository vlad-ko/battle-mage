# Battle Mage (@bm)

A Slack agent powered by Claude AI that answers questions about your GitHub codebase. Mention `@bm` in any channel and ask about code, architecture, GitHub issues, or pull requests — the agent reads your repo in real time to give grounded answers.

<img src="icon.png" alt="Battle Mage icon" width="128">

## What It Does

- **Answers code questions** — "Where is authentication handled?" "What does the OrderService do?" The agent searches your repo, reads the actual files, and responds with specific file paths and line numbers.
- **Reads GitHub issues and PRs** — "What are the open bugs?" "Summarize PR #42." It pulls live data from GitHub, not cached summaries.
- **Creates GitHub issues** — Ask it to file a bug or feature request. It drafts the issue and shows you a preview. Nothing gets created until you react with ✅ — there are no surprises.
- **Remembers corrections** — If the agent gets something wrong and you correct it, it saves that fact to a knowledge base file in your repo (`.battle-mage/knowledge.md`). Next time anyone asks, it knows the right answer. The knowledge base is just a markdown file — your team can read, edit, or delete entries at any time.
- **Follows threads** — After the first `@bm` mention, you can keep chatting in the same thread without mentioning it again. It knows it's part of the conversation.
- **Loads your project context** — If your repo has a `CLAUDE.md` file (common in projects using Claude), the agent reads it on startup and uses it to understand your project's conventions, architecture, and terminology.

## Getting Started

### 1. Clone and install

```bash
git clone <your-fork-url>
cd battle-mage
npm install
```

### 2. Create a Slack app

This is the part that trips people up the most, so here's the play-by-play:

1. Go to [api.slack.com/apps?new_app=1](https://api.slack.com/apps?new_app=1)
2. Choose **"From a manifest"** — this is the fastest path
3. Select your workspace
4. Switch to the **YAML** tab and paste the contents of `slack-app-manifest.yaml` from this repo
5. Review and click **Create**

> **Important:** The manifest includes a placeholder `request_url`. You'll update this to your real Vercel URL after deploying (step 5). Don't worry about the "URL not verified" warning for now — it's expected.

After creating the app:

6. Go to **Install App** in the left sidebar and click **Install to Workspace**. Authorize it.
7. You now have two values you'll need:
   - **Bot User OAuth Token** (`xoxb-...`) — find it on the **OAuth & Permissions** page, at the top under "OAuth Tokens for Your Workspace"
   - **Signing Secret** — find it on **Basic Information** page under "App Credentials". Click "Show" to reveal it.

> **Customizing the bot handle:** The manifest sets the display name to `bm`, so users will type `@bm`. If you want a different handle, change `display_name` in the manifest before creating the app, or edit it later under **App Home** in the Slack dashboard. Keep in mind that the handle is what people type every day, so shorter is better.

### 3. Create a GitHub PAT

The agent needs read access to your target repo (and write access to GitHub Issues, if you want issue creation).

1. Go to [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta) (fine-grained PATs)
2. Click **Generate new token**
3. Under **Repository access**, select **"Only select repositories"** and pick your target repo
4. Set these permissions:

| Permission | Level | Why |
|-----------|-------|-----|
| Contents | Read | Search code, read files |
| Issues | Read & Write | List GitHub issues, create new ones |
| Pull requests | Read | Read PR details |
| Metadata | Read | Required baseline (auto-selected) |

5. Set an expiration (90 days is reasonable) and **set a calendar reminder to rotate it** — expired PATs fail silently and the bot just stops being able to read your repo.

> **Why fine-grained?** Classic PATs grant access to ALL your repos. Fine-grained PATs are scoped to specific repositories, which is much safer. If the token leaks, the blast radius is one repo, not your entire GitHub account.

### 4. Set environment variables

You'll need an [Anthropic API key](https://console.anthropic.com) if you don't have one already.

Copy the example file and fill in the values:

```bash
cp .env.example .env.local
```

| Variable | Where to get it |
|----------|----------------|
| `SLACK_BOT_TOKEN` | Slack app > OAuth & Permissions > Bot User OAuth Token |
| `SLACK_SIGNING_SECRET` | Slack app > Basic Information > App Credentials > Signing Secret |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) > API Keys |
| `GITHUB_PAT_BM` | The fine-grained PAT you just created |
| `GITHUB_OWNER` | The GitHub org or username that owns the target repo (e.g., `acme-corp`) |
| `GITHUB_REPO` | The repo name (e.g., `backend`) |

### 5. Deploy to Vercel

The simplest path:

```bash
npm install -g vercel   # if you don't have it
vercel login            # authenticate (opens browser)
vercel link             # connect this directory to a Vercel project
vercel env add SLACK_BOT_TOKEN production
vercel env add SLACK_SIGNING_SECRET production
vercel env add ANTHROPIC_API_KEY production
vercel env add GITHUB_PAT_BM production
vercel env add GITHUB_OWNER production
vercel env add GITHUB_REPO production
vercel --prod           # deploy
```

Each `vercel env add` command will prompt you to paste the value. They're stored encrypted in Vercel's dashboard.

After the deploy succeeds, note your production URL (e.g., `https://your-project.vercel.app`).

### 6. Connect Slack to your deploy

Now go back to your Slack app settings:

1. Go to **Event Subscriptions** in the left sidebar
2. Set the **Request URL** to: `https://your-project.vercel.app/api/slack`
3. Slack will send a verification challenge. If everything is wired up correctly, you'll see a green **"Verified"** checkmark within a few seconds.

> **If verification fails:** Check that your env vars are set correctly in Vercel (especially `SLACK_SIGNING_SECRET`), and that the deploy completed successfully. You can check Vercel's function logs for errors.

### 7. Invite and test

In any Slack channel:

```
/invite @bm
@bm what does this repo do?
```

You should see:
1. A "🧠 Battle Mage is thinking..." message appear immediately
2. A detailed response in the thread a few seconds later

If nothing happens, check the Vercel function logs (`vercel logs --prod`) for errors.

## Using Battle Mage

### Asking questions

Just `@bm` followed by your question in any channel the bot has been invited to:

```
@bm where is the payment processing logic?
@bm what are the open GitHub issues labeled "bug"?
@bm show me the contents of src/config/database.ts
@bm summarize PR #87
```

The agent has access to these GitHub tools and will use them automatically:
- **Code search** — finds files matching your query across the repo
- **File read** — reads the actual content of specific files
- **GitHub issue/PR lookup** — lists and reads GitHub issues and pull requests

### Follow-up questions

After the first `@bm` mention in a thread, you can reply normally without mentioning the bot again. It detects that it's already participating in the thread and responds to follow-ups automatically.

```
You:  @bm how does the auth middleware work?
Bot:  [explains auth middleware]
You:  what about the refresh token logic?        ← no @bm needed
Bot:  [explains refresh tokens]
```

> **Heads up:** The bot does NOT have conversation memory across threads. Each thread is an independent conversation. If you start a new thread, you're starting fresh.

### Creating GitHub issues

Ask the bot to create an issue and it will draft one for you:

```
@bm create an issue: the login page crashes on Safari when cookies are disabled
```

The bot will show you a preview with a title, body, and suggested labels. **Nothing is created yet.** React with ✅ on the bot's message to confirm and actually create the issue on GitHub. If you ignore it or don't react, nothing happens.

> **Why the confirmation step?** Because creating GitHub issues is a write operation that's visible to your whole team. The bot should never surprise anyone with unexpected issues appearing in the backlog.

### Correcting the bot

If the bot gives you wrong information, just tell it:

```
Bot:  The auth module is in app/Http/Auth...
You:  That's wrong — auth lives in app/Services/Auth since the v3 refactor
Bot:  Got it, I'll save that to the knowledge base.
```

The bot commits a correction to `.battle-mage/knowledge.md` in your target repo. This file is loaded into every future conversation, so the bot won't make the same mistake again.

You can review, edit, or delete entries in that file anytime — it's just a markdown file in your repo. Each entry is timestamped so you can see when it was learned.

## Architecture

### Why these choices?

| Decision | Why |
|----------|-----|
| **Vercel + Next.js** | Serverless means no servers to maintain, scales to zero when idle, and deploys on every push to main. |
| **Webhook mode** (not Socket mode) | Vercel serverless functions can't maintain persistent WebSocket connections. Webhook mode works naturally with request/response. |
| **Ack-then-process** | Slack requires a 200 OK within 3 seconds or it retries (and shows errors). The API route acks immediately, then uses Next.js `after()` to process the AI call asynchronously while Vercel keeps the function alive. |
| **Thread-only replies** | Posting at channel root would be noisy and disruptive. Thread replies keep conversations contained. |
| **Reaction-based confirmation** | Simpler than interactive buttons (no interactivity endpoint needed), and it's a natural Slack gesture. ✅ to confirm, ignore to cancel. |
| **Knowledge file in the target repo** | Corrections are version-controlled, visible to the team, and don't require a database. Anyone can review or edit them. |

### How the agent loop works

When the bot receives a message, it enters a tool-use loop with Claude:

1. Send the user's message to Claude along with the system prompt (which includes CLAUDE.md and the knowledge base)
2. Claude decides whether to use a tool (search code, read a file, etc.) or respond directly
3. If Claude uses a tool, execute it and feed the result back to Claude
4. Repeat until Claude gives a final text response (max 10 rounds)
5. Post the response to the Slack thread

This means the bot can chain multiple tools together. For example, it might search for a function name, read the file it's in, then read a related test file, before synthesizing an answer.

### Project structure

```
src/
  app/
    api/slack/route.ts    — Webhook handler: mentions, reactions, thread follow-ups
    page.tsx              — Landing page (just a status page)
  lib/
    slack.ts              — Slack client, signature verification, message helpers
    claude.ts             — Claude client, system prompt builder, agent loop
    github.ts             — GitHub client: code search, file read, issues, PRs, knowledge
  tools/
    search-code.ts        — Code search tool definition + executor
    read-file.ts          — File read tool definition + executor
    list-issues.ts        — Issue list/lookup tool definition + executor
    create-issue.ts       — Issue proposal tool + message parser
    save-knowledge.ts     — Knowledge base save tool + executor
slack-app-manifest.yaml   — Slack app manifest for one-step app creation
```

## Troubleshooting

### Bot doesn't respond at all
- Is the bot invited to the channel? (`/invite @bm`)
- Is the Event Subscription URL verified in the Slack dashboard?
- Check Vercel function logs: `vercel logs --prod`
- Are all 6 env vars set? `vercel env ls`

### Bot responds but can't read the repo
- Is `GITHUB_PAT_BM` set and not expired?
- Is the PAT scoped to the correct repo (`GITHUB_OWNER`/`GITHUB_REPO`)?
- Does the PAT have "Contents: Read" permission?

### Formatting looks wrong (raw `##` or `**` in messages)
- This was a known issue — the bot's output is now post-processed to convert markdown to Slack mrkdwn. If you still see artifacts, check that you're running the latest deploy.

### "Thinking..." message appears but no follow-up
- The Claude API call is probably timing out. Vercel's Hobby plan has a 10-second function timeout. Upgrade to Pro for 60-second timeouts, which is usually enough.
- Check Vercel function logs for timeout errors.

### Thread follow-ups don't work
- Make sure your Slack app is subscribed to `message.channels` and `message.groups` events (check **Event Subscriptions** > **Subscribe to bot events** in the Slack dashboard)
- The bot only responds in threads where it has already replied. It won't respond to random thread messages in channels it's in.

## Local Development

```bash
npm run dev     # Start Next.js dev server on port 3000
npm run build   # Production build
npm run lint    # ESLint
npm run typecheck  # TypeScript strict mode check
```

For local testing with Slack, you'll need a tunnel (like [ngrok](https://ngrok.com)) to expose your local server:

```bash
ngrok http 3000
# Copy the https URL and set it as your Slack Event Subscription URL
# Remember to change it back to your Vercel URL when you're done
```

## Contributing

Contributions are welcome! Here's how the process works:

1. **Fork the repo** — don't clone it directly. Direct pushes to `main` are blocked for everyone, including maintainers. All changes go through pull requests.

2. **Create a feature branch** on your fork:
   ```bash
   git checkout -b feat/my-change
   ```

3. **Make your changes.** Before pushing, make sure everything passes:
   ```bash
   npm run typecheck   # TypeScript strict mode — no errors allowed
   npm run build       # Full production build must succeed
   ```

4. **Open a pull request** against `main`. Include:
   - A clear description of what you changed and why
   - Steps to test it, if applicable
   - Screenshots for UI changes

5. **Wait for review.** PRs require at least one approving review before they can be merged. Stale approvals are dismissed automatically when new commits are pushed, so reviewers always see the latest code.

### Branch protection

The `main` branch has these protections enabled:

- **No direct pushes** — everything goes through a PR
- **1 approving review required** — for outside contributors
- **Stale review dismissal** — pushing new commits resets previous approvals
- **Linear history** — merge commits are not allowed; use rebase or squash
- **No force pushes or branch deletion**

### What makes a good contribution?

- **Bug fixes** — especially around Slack formatting edge cases or error handling
- **New tools** — adding new GitHub capabilities (e.g., reading commit history, browsing branches)
- **Documentation** — if you hit a setup snag that isn't covered, add it to the troubleshooting section
- **Tests** — the project currently has no test suite, so this is a great area to contribute

### What to avoid

- Don't add external dependencies without discussing it in an issue first
- Don't change the core agent loop without a clear rationale
- Don't add features that require new infrastructure (databases, queues, etc.) — the project is intentionally serverless and stateless

## License

MIT
