# Setup Guide

This guide walks you through deploying Battle Mage from scratch. You will create a Slack app, a GitHub personal access token, a Vercel project with KV storage, and wire them all together.

Estimated time: 20-30 minutes.

## Prerequisites

- A Slack workspace where you have permission to install apps
- A GitHub account with access to the repository you want Battle Mage to read
- A Vercel account (free tier works)
- An Anthropic API key ([console.anthropic.com](https://console.anthropic.com))
- Node.js 18.17+ installed locally

## 1. Create the Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** > **From a manifest**.

Select your workspace, then paste this manifest (YAML):

```yaml
display_information:
  name: Battle Mage
  description: AI assistant for your GitHub codebase
  background_color: "#1a1a2e"

features:
  bot_user:
    display_name: bm
    always_online: true

oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - reactions:read
      - reactions:write

settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - reaction_added
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Click **Create**. You will configure the event subscription URL after deploying to Vercel (step 5).

### Install to Workspace

From your app's settings page:

1. Go to **OAuth & Permissions** in the sidebar
2. Click **Install to Workspace** and approve the permissions
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`) -- you will need this as `SLACK_BOT_TOKEN`
4. Go to **Basic Information** and copy the **Signing Secret** -- you will need this as `SLACK_SIGNING_SECRET`

> **Gotcha**: The signing secret is under Basic Information, not OAuth & Permissions. They are different credentials.

### Required Scopes Explained

| Scope | Why |
|-------|-----|
| `app_mentions:read` | Detect when someone @mentions the bot |
| `channels:history` | Read thread messages for follow-up context |
| `channels:read` | Access channel info |
| `chat:write` | Post replies in threads |
| `groups:history` | Same as channels:history but for private channels |
| `groups:read` | Same as channels:read but for private channels |
| `reactions:read` | Detect thumbs up/down and checkmark reactions |
| `reactions:write` | Add brain emoji to acknowledge positive feedback |

## 2. Create a GitHub Fine-Grained PAT

Go to [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta) and create a **fine-grained personal access token**.

Configuration:

- **Token name**: `battle-mage` (or whatever you prefer)
- **Expiration**: 90 days (GitHub's maximum for fine-grained tokens; set a calendar reminder to rotate)
- **Repository access**: Select **Only select repositories** and pick the repo you want Battle Mage to read
- **Permissions**: Set these repository permissions:

| Permission | Access Level | Why |
|-----------|-------------|-----|
| Contents | Read-only | Read files, list directory trees, fetch commits |
| Issues | Read and write | List issues and create new ones (via confirmation flow) |
| Pull requests | Read-only | List recent PRs and read PR details |
| Metadata | Read-only | Required by GitHub for all fine-grained PATs |

Click **Generate token** and copy it immediately. This is your `GITHUB_PAT_BM`.

> **Tip**: The PAT does NOT need Contents: Write. Battle Mage never pushes code. The knowledge base lives in Vercel KV, not in the GitHub repo.

> **Gotcha**: If you select "All repositories" instead of scoping to one repo, Battle Mage will still only operate on the repo specified by `GITHUB_OWNER` and `GITHUB_REPO`. But scoping the PAT to a single repo is better security practice.

## 3. Deploy to Vercel

### Option A: Deploy via CLI (recommended)

```bash
# Clone the repo
git clone https://github.com/your-fork/battle-mage.git
cd battle-mage
npm install

# Install Vercel CLI if you don't have it
npm i -g vercel

# Link to Vercel (creates project if needed)
vercel link

# Set environment variables
vercel env add SLACK_BOT_TOKEN        # paste your xoxb-... token
vercel env add SLACK_SIGNING_SECRET   # paste signing secret
vercel env add ANTHROPIC_API_KEY      # paste sk-ant-... key
vercel env add GITHUB_PAT_BM         # paste github_pat_... token
vercel env add GITHUB_OWNER           # e.g. "acme-corp"
vercel env add GITHUB_REPO            # e.g. "backend"

# Deploy to production
vercel --prod
```

### Option B: Deploy via Vercel Dashboard

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your fork of the battle-mage repo
3. Add all six environment variables in the **Environment Variables** section before deploying
4. Click **Deploy**

### Set Up Upstash Redis

Battle Mage uses Upstash Redis (via the Vercel Marketplace integration) for the knowledge base, feedback storage, and repo index cache.

1. Go to your project in the Vercel dashboard
2. Navigate to **Storage** tab (or **Integrations** → **Marketplace**)
3. Add the **Upstash** integration and create a Redis database
4. Name it something like `battle-mage-redis`
5. Connect it to your project

The integration sets both sets of env vars — `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (the canonical names) plus the legacy `KV_REST_API_URL` / `KV_REST_API_TOKEN` aliases. The app's `Redis.fromEnv()` client reads whichever pair is present, so either works.

> **Legacy note**: Older deployments provisioned "Vercel KV" (which was a thin wrapper over Upstash Redis). Those still work — `KV_REST_API_*` env vars are read as a fallback by `@upstash/redis`. New projects should use the Upstash Marketplace integration directly.

> **Gotcha**: If you skip this step, the bot will still work for basic Q&A -- but the knowledge base, feedback, and repo index features will silently degrade. You will see no errors, but corrections will not persist and the repo map will not be cached.

### For Local Development

```bash
cp .env.example .env.local
```

Fill in all the credentials. For Redis, pull the credentials from Vercel:

```bash
vercel env pull .env.local
```

This will add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (and/or the legacy `KV_REST_API_*` aliases) to your `.env.local`.

Then start the dev server:

```bash
npm run dev
```

The app runs at `http://localhost:3000`. For local Slack testing, you will need a tunnel (like ngrok) to expose your local server to Slack's webhook.

## 4. Connect Slack to Your Deployment

Once deployed, your app URL will be something like `https://battle-mage-abc123.vercel.app`.

1. Go back to [api.slack.com/apps](https://api.slack.com/apps) and select your app
2. Go to **Event Subscriptions** in the sidebar
3. Toggle **Enable Events** to ON
4. Set the **Request URL** to: `https://your-domain.vercel.app/api/slack`
5. Slack will send a verification challenge -- your app should respond with `200 OK` and the challenge value. If this fails, check that your environment variables are set correctly.
6. Click **Save Changes**

> **Gotcha**: The URL must end with `/api/slack` exactly. This is the Next.js API route that handles all Slack events.

> **Gotcha**: If verification fails, the most common cause is that the deployment has not finished yet. Wait for the Vercel deployment to complete, then retry.

## 5. Invite the Bot to a Channel

In Slack:

1. Go to the channel where you want to use Battle Mage
2. Type `/invite @bm` or click the channel settings and add the app
3. The bot will now listen for @mentions and reactions in that channel

## 6. First Test

In the channel where you invited the bot, type:

```
@bm What is the project structure?
```

You should see:

1. A thinking message appear with a brain emoji header
2. The status line updating as the bot searches and reads files (magnifying glass for search, glasses for file reads)
3. The thinking message disappear
4. A final answer with the project structure, followed by reference links

If the bot does not respond, check the [Troubleshooting Guide](./troubleshooting.md).

## Environment Variables Reference

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | Yes | `xoxb-123-456-abc` | Bot OAuth token from Slack app settings |
| `SLACK_SIGNING_SECRET` | Yes | `abc123def456` | Signing secret from Slack Basic Information |
| `ANTHROPIC_API_KEY` | Yes | `sk-ant-api03-...` | API key from Anthropic console |
| `GITHUB_PAT_BM` | Yes | `github_pat_...` | Fine-grained PAT scoped to your target repo |
| `GITHUB_OWNER` | Yes | `acme-corp` | GitHub organization or username |
| `GITHUB_REPO` | Yes | `backend` | Repository name |
| `UPSTASH_REDIS_REST_URL` | Auto | `https://...upstash.io` | Injected by the Upstash Vercel integration -- do not set manually |
| `UPSTASH_REDIS_REST_TOKEN` | Auto | `AaB1Cc2...` | Injected by the Upstash Vercel integration -- do not set manually |
| `KV_REST_API_URL` | Legacy | `https://...upstash.io` | Read as a fallback by `@upstash/redis` for projects that still provision "Vercel KV" |
| `KV_REST_API_TOKEN` | Legacy | `AaB1Cc2...` | Read as a fallback — either pair works |

## Security Notes

- The `SLACK_SIGNING_SECRET` is used to verify that incoming webhooks are genuinely from Slack (HMAC-SHA256 with 5-minute timestamp tolerance). Never disable this.
- The GitHub PAT should be scoped to the minimum permissions listed above. Never grant write access to Contents.
- All environment variables should be set in Vercel's encrypted environment variable store, not committed to the repo.
- The `.env.local` file is in `.gitignore` and should never be committed.

## Optional: Configure Path Annotations

Add a `.battle-mage.json` file to the root of your **target repo** to tell the agent which areas to prioritize, deprioritize, or ignore. This is optional — the agent works fine without it, but annotations make it smarter about your specific codebase.

See [Path Annotations](./features/config.md) for the full guide.

## Next Steps

- [Usage Guide](./usage.md) -- how to use the bot day-to-day
- [Architecture](./architecture.md) -- how the internals work
- [Path Annotations](./features/config.md) -- configure trust levels per path
- [Troubleshooting](./troubleshooting.md) -- common issues and fixes
