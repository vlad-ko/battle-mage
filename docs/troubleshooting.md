# Troubleshooting

Common issues and how to fix them.

## Bot Does Not Respond to @mentions

**Symptom**: You @mention the bot in a channel and nothing happens. No thinking message, no reply.

**Check these in order:**

1. **Is the bot invited to the channel?** Type `/invite @bm` in the channel. The bot only receives events from channels it has been added to.

2. **Is the event subscription URL set?** Go to [api.slack.com/apps](https://api.slack.com/apps) > your app > Event Subscriptions. The Request URL should be `https://your-domain.vercel.app/api/slack` and show a green "Verified" checkmark.

3. **Are the correct bot events subscribed?** Under Event Subscriptions > Subscribe to bot events, you need: `app_mention`, `message.channels`, `message.groups`, `reaction_added`.

4. **Is the deployment healthy?** Check your Vercel dashboard for deployment errors. Look at the function logs for the `/api/slack` route.

5. **Are environment variables set?** In Vercel dashboard > Settings > Environment Variables, verify all six required variables are present: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY`, `GITHUB_PAT_BM`, `GITHUB_OWNER`, `GITHUB_REPO`.

6. **Is signature verification failing?** Check Vercel function logs for "Invalid signature" 401 responses. This means the `SLACK_SIGNING_SECRET` does not match the signing secret from your Slack app's Basic Information page.

7. **Is Slack retrying?** If the bot takes too long, Slack retries the event. The handler rejects retries via the `x-slack-retry-num` header, which is correct -- but if the first request also failed, you will see no response. Check Vercel logs for errors in the `after()` callback.

## Bot Responds With an Error Message

**Symptom**: The bot replies with "Something went wrong while processing your request."

**Check:**

- **Anthropic API key**: Is `ANTHROPIC_API_KEY` valid and not expired? Test it with a curl request to the Anthropic API.
- **GitHub PAT**: Is `GITHUB_PAT_BM` valid and not expired? Fine-grained PATs expire -- check the expiration date at [github.com/settings/tokens](https://github.com/settings/tokens).
- **Rate limits**: Both GitHub and Anthropic APIs have rate limits. If you are hitting them, you will see errors in the Vercel function logs.
- **Vercel function logs**: The error message is logged to console. Check Vercel dashboard > Logs for the specific error.

## Bot Cannot Read the Repository

**Symptom**: The bot says it cannot find files, or search returns no results.

**Check:**

- **GITHUB_OWNER and GITHUB_REPO**: Are these set correctly? They should be the org/user and repo name (e.g., `acme-corp` and `backend`), not the full URL.
- **PAT repository access**: The fine-grained PAT must be scoped to the correct repository. Check at [github.com/settings/tokens](https://github.com/settings/tokens) > your token > Repository access.
- **PAT permissions**: The token needs Contents (read), Issues (read/write), Pull requests (read), and Metadata (read). If any are missing, certain tools will fail.
- **Private repo**: If the repo is private, make sure the PAT has access. Fine-grained PATs for private repos require the token owner to have access to the repo.

## Formatting Looks Wrong in Slack

**Symptom**: You see raw `##` or `**` characters in the bot's responses.

**This is expected for some edge cases.** The `toSlackMrkdwn()` converter handles:
- `## Heading` -> `*Heading*` (Slack bold)
- `**bold**` -> `*bold*` (Slack bold)

**Known limitations:**
- Headings inside code blocks will be converted incorrectly. A `## comment` inside triple backticks will become `*comment*`. This is a known tradeoff that rarely matters in practice.
- Slack does not support tables, so table-formatted content will appear as raw text.
- Nested formatting (e.g., bold inside italic) may not render correctly in Slack.

## Timeout Issues

**Symptom**: The thinking message appears but the bot never replies, or the answer is cut off.

**Possible causes:**

- **Vercel function timeout**: By default, Vercel Hobby plans have a 10-second function timeout. The `after()` callback runs outside the response lifecycle but still has a maximum execution time based on your plan. Pro plans get up to 60 seconds, Enterprise gets more.
- **Complex questions**: If the bot uses all 15 tool rounds, each involving a GitHub API call and a Claude API call, the total execution time can exceed timeout limits.
- **Large files**: Reading very large files from GitHub can be slow. The bot does not paginate or truncate file reads.

**Fixes:**
- Upgrade to a Vercel Pro plan for longer function execution times
- Ask more specific questions that require fewer tool rounds
- If the thinking message was posted but the answer was not, the thinking message may remain in the thread. The bot deletes it just before posting the answer, so a timeout means the delete and reply never happened.

## Thread Follow-Ups Not Working

**Symptom**: You post in a thread where the bot has replied, but the bot does not respond to your follow-up.

**Check:**

1. **Is this a thread reply?** Follow-ups only work for threaded replies, not top-level messages. Make sure you are replying in the thread, not posting a new message in the channel.

2. **Has the bot actually replied in this thread?** The bot checks `conversations.replies` to see if it has posted in the thread. If the bot's previous message was deleted, it will not respond to follow-ups.

3. **Does the message @mention the bot?** If your follow-up includes `@bm`, it will be handled by the `app_mention` handler, not the thread follow-up handler. Both should work, but if the `app_mention` handler fires, the thread follow-up handler skips the message to avoid duplicates.

4. **Is the bot's user ID resolvable?** The bot calls `auth.test()` to get its own user ID (cached per cold start). If this fails, the thread follow-up handler cannot determine if the bot has replied in the thread.

5. **Are `channels:history` and `groups:history` scopes granted?** These are required for the bot to read thread history. Without them, `conversations.replies` will fail silently.

## KV Not Configured (Knowledge Base Not Working)

**Symptom**: The bot works for basic Q&A but corrections are not persisted, the repo index is not cached, and feedback has no effect.

**Check:**

- **Is a KV store linked?** Go to your Vercel project > Storage tab. You should see a KV database connected.
- **Are KV credentials present?** Vercel auto-injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`. Check that these appear in your Environment Variables.
- **Local development**: For local dev, you need to pull KV credentials: `vercel env pull .env.local`. Without these, the KV-dependent features silently degrade -- no errors, but no persistence either.

**Graceful degradation**: If KV is not available, the bot still answers questions. It just cannot:
- Save or retrieve knowledge base entries
- Store or process feedback (thumbs up/down)
- Cache the repo index (rebuilds on every request)

## Progress Message Not Updating

**Symptom**: The thinking message appears but the status line never changes.

**Possible causes:**

- **Slack API rate limits**: The bot calls `chat.update` on every tool call. If Slack rate-limits these calls, updates will be silently dropped.
- **The bot lacks `chat:write` scope**: This is unlikely if the bot can post messages at all, but double-check the OAuth scopes.
- **The message was deleted**: If someone deletes the thinking message while the bot is processing, `chat.update` calls will fail silently (the handler does not crash, it just continues).

## Issue Creation Fails After Checkmark Reaction

**Symptom**: You react with :white_check_mark: but no issue is created.

**Check:**

- **Is `reactions:read` scope granted?** Without this, the bot does not receive `reaction_added` events.
- **Was the reaction on the bot's message?** The handler verifies that the reacted message was posted by the bot. If someone copies the proposal text into their own message and you react to that, nothing happens.
- **Does the PAT have Issues (read/write) permission?** Creating issues requires write access. If the PAT only has read access, the API call will fail.
- **Check Vercel logs**: The error is logged with the message "Battle Mage reaction handler error".

## Still Stuck?

1. Check Vercel function logs (Dashboard > your project > Logs)
2. Check Slack app activity logs (api.slack.com/apps > your app > App Activity Log)
3. Open a GitHub issue with the `bug` label, including the error message and steps to reproduce
