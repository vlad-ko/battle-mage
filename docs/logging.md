# Logging

Battle Mage uses structured JSON logging to trace every event from an @mention through the agent loop to the final response. Logs are captured automatically by Vercel's serverless function runtime.

## Viewing Logs

**Vercel Dashboard:** Project > Logs (real-time tail with filtering)

**CLI:**
```bash
vercel logs --prod          # Last entries
vercel logs --prod --follow # Live tail
```

**Retention:** 1 hour (Hobby), 1 day (Pro), 3 days (Enterprise). For longer retention, set up a [Log Drain](https://vercel.com/docs/observability/log-drains) to Datadog, Axiom, or similar.

**Sentry (primary sink for production):** Vercel's `vercel logs` CLI drops writes made inside Next.js `after()` callbacks — a known serverless quirk. All of battle-mage's per-round agent logs (`agent_start`, `agent_tool_call`, `agent_complete` with cache + token metrics, `answer_posted`) happen inside `after()`, so they surface through Sentry, not the Vercel log drain.

Set `SENTRY_DSN` in your Vercel project env vars (from your Sentry.io project). Without a DSN the SDK is a silent no-op — console.log is the only sink, which works fine for sync code but misses the `after()` path. With a DSN, every `log(...)` call dual-emits: once to stdout and once to `Sentry.logger.info` / `.error`. See [Sentry Next.js SDK docs](https://docs.sentry.io/platforms/javascript/guides/nextjs/) for setup.

Why this works on Vercel when stdout doesn't: `@sentry/nextjs` internally calls `vercelWaitUntil(Sentry.flush())` to hold the function container open until events are transmitted. That's the same mechanism `getsentry/junior` uses on their Vercel-hosted Hono agent.

## Log Format

Every log entry is a single JSON line:

```json
{"event":"mention_received","requestId":"a3f2b1c4","channel":"C0G9QF9GZ","user":"U024BE7LH","question":"what does the auth module do?","ts":1711924800000}
```

| Field | Type | Description |
|-------|------|-------------|
| `event` | string | What happened (see event catalog below) |
| `requestId` | string | 8-char ID correlating all events in one webhook invocation |
| `ts` | number | Unix timestamp in milliseconds |
| ...data | various | Event-specific context |

## Request Correlation

Every webhook invocation creates a `requestId` (8-char random string). All log entries from that invocation share the same ID. This lets you trace a single question from mention to answer:

```
Filter: requestId=a3f2b1c4

{"event":"mention_received","requestId":"a3f2b1c4","question":"what does auth do?","ts":1711924800000}
{"event":"agent_start","requestId":"...","promptLength":4200,"ts":1711924800050}
{"event":"agent_tool_call","requestId":"...","tool":"search_code","round":0,"ts":1711924800100}
{"event":"agent_tool_call","requestId":"...","tool":"read_file","round":1,"ts":1711924802000}
{"event":"agent_complete","requestId":"...","rounds":2,"duration_ms":3500,"ts":1711924803500}
{"event":"answer_posted","requestId":"...","channel":"C0G9QF9GZ","ts":1711924804000}
```

## Event Catalog

### Webhook Events (route.ts)

| Event | When | Key data |
|-------|------|----------|
| `signature_rejected` | Slack signature verification fails | — |
| `mention_received` | @bm mentioned in a channel | channel, user, question |
| `thread_followup` | Reply in thread where bot is participating | channel, threadTs |
| `reaction_checkmark` | ✅ on a proposal message | channel, messageTs |
| `reaction_thumbsup` | 👍 on a bot answer | channel, messageTs |
| `reaction_thumbsdown` | 👎 on a bot answer | channel, messageTs |

### Agent Events (claude.ts)

| Event | When | Key data |
|-------|------|----------|
| `agent_start` | Agent loop begins | promptLength, question |
| `agent_tool_call` | Each tool execution | tool, round, input (truncated) |
| `agent_complete` | Agent produces final answer | rounds, refCount, hasProposal, duration_ms |

### Index Events (repo-index.ts)

| Event | When | Key data |
|-------|------|----------|
| `index_cache_hit` | Index is fresh, using cached version | sha |
| `config_loaded` | .battle-mage.json read from repo | hasConfig, pathCount |
| `index_rebuilt` | Index rebuilt after SHA change | sha, topicCount, fileCount, duration_ms |
| `index_build_error` | Index build failed | message |

### Response Events (route.ts)

| Event | When | Key data |
|-------|------|----------|
| `answer_posted` | Bot's answer sent to Slack | channel, threadTs |
| `issue_created` | GitHub issue created after ✅ | number |
| `correction_saved` | User's correction saved to KB | entry (truncated) |
| `feedback_positive` | 👍 feedback recorded | question (truncated) |
| `feedback_negative` | 👎 analysis complete | kbFlagged, docsFlagged |
| `followup_agent_start` | Thread follow-up triggering agent | channel, threadTs |

### Error Events (all flows)

| Event | When | Key data |
|-------|------|----------|
| `error` | Any unhandled error in a flow | flow, message |

The `flow` field identifies which handler failed: `mention`, `thread_followup`, `reaction_checkmark`, `reaction_thumbsup`, `reaction_thumbsdown`.

## Debugging Common Issues

### "Bot doesn't respond"

Filter for `mention_received` — if it's missing, the webhook isn't reaching your function. Check Slack Event Subscriptions URL.

If `mention_received` exists but no `agent_complete`, the agent loop is timing out. Check `agent_tool_call` events to see how many rounds were used and which tools were called.

### "Answer is wrong"

Look at `agent_tool_call` events to see what the agent searched for and which files it read. This reveals whether the agent looked at the right sources or went down the wrong path.

### "Index not rebuilding"

If you see `index_cache_hit` on every request, the SHA hasn't changed since the last build. If you see `index_build_error`, the GitHub API call failed (check PAT permissions).

### "Feedback not working"

After a 👍/👎, look for `feedback_positive`/`feedback_negative` events. If missing, the Q&A context may have expired (7-day TTL) or the reacted-to message wasn't a bot answer.

## Implementation

The logger is in `src/lib/logger.ts`:

```typescript
// Simple structured log
log("event_name", { key: "value" });

// Request-scoped logger (all calls share a requestId)
const rlog = createRequestLogger();
rlog("step_one", { data: "..." });
rlog("step_two", { data: "..." });
// Both entries have the same requestId
```

Every call dual-emits:
1. `console.log` (or `console.error` for events containing "error") with a JSON payload — surfaces in Vercel's log drain for sync code.
2. `Sentry.logger.info` / `.error` — surfaces in Sentry.io for code running inside `after()` callbacks (where stdout is unreliable on Vercel).

The Sentry path is a silent no-op when `SENTRY_DSN` is unset (local dev, CI, tests), so the logger works identically without Sentry configured.

Sentry init lives in `sentry.server.config.ts` (project root) and is loaded via `instrumentation.ts` on the Node runtime. See those files for tunable options (`SENTRY_TRACES_SAMPLE_RATE`, etc.).
