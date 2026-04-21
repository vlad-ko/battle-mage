# Observability

Battle Mage observability has two layers:

1. **Structured logs** — every event (mention, tool call, agent completion, answer posted, errors) is emitted as a JSON line to stdout AND as a Sentry event. See "Log Format" and "Event Catalog" below.
2. **Tracing** — not on the roadmap. `vercelAIIntegration` stays wired in `sentry.server.config.ts` for the day we want OpenTelemetry `gen_ai.*` spans, but capturing them would require migrating the agent loop off the bare `@anthropic-ai/sdk` onto Vercel AI SDK's `streamText`, which would touch the parallel-tools dispatch (#77), compaction (#76), budget guards (#93), and streaming pipeline. The refactor cost vs. the marginal visibility over our existing request-correlated logs + per-turn metrics footer + Sentry stack traces isn't favorable. Revisit only if an independent reason to rewrite the agent loop appears.

The rest of this doc focuses on logs — traces will get their own section once spans are flowing.

## Viewing Logs

**Vercel Dashboard:** Project > Logs (real-time tail with filtering)

**CLI:**
```bash
vercel logs --prod          # Last entries
vercel logs --prod --follow # Live tail
```

**Retention:** 1 hour (Hobby), 1 day (Pro), 3 days (Enterprise). For longer retention, set up a [Log Drain](https://vercel.com/docs/observability/log-drains) to Datadog, Axiom, or similar.

**Sentry (primary sink for production):** Vercel's `vercel logs` CLI drops writes made inside Next.js `after()` callbacks — a known serverless quirk. All of battle-mage's per-round agent logs (`agent_start`, `agent_tool_call`, `agent_complete` with cache + token metrics, `answer_posted`) happen inside `after()`, so they surface through Sentry, not the Vercel log drain.

`SENTRY_DSN` in your Vercel project env vars overrides the hardcoded public DSN baked into `sentry.server.config.ts` / `sentry.edge.config.ts` / `src/instrumentation-client.ts`. **Important:** the hardcoded fallback means Sentry is active even when `SENTRY_DSN` is unset — code built from this repo always ships telemetry somewhere. To truly disable Sentry you must remove the hardcoded fallback (or comment out `Sentry.init`); unsetting the env var alone does not stop data egress. With Sentry active, `sentry.server.config.ts` wires `consoleLoggingIntegration` so every `console.log(JSON.stringify(...))` emitted by the logger is captured and shipped to Sentry's Logs UI automatically — no explicit `Sentry.logger.*` calls in application code. See [Sentry Next.js SDK docs](https://docs.sentry.io/platforms/javascript/guides/nextjs/logs/) for setup.

**Sentry Logs is a billed product.** Each org gets a monthly byte quota (5 GB included on Team/Business; zero on the Developer free tier). When the quota is exhausted, Sentry responds `429 log_byte_usage_exceeded` and every log envelope is silently dropped until the window resets or pay-as-you-go is enabled. Exception events use a separate quota (`error`), so Issues may keep arriving while Logs go dark. If you see an empty Logs UI despite traffic, verify the org's logs usage in Settings → Subscription before digging into SDK config.

**Operator note — data that flows to Sentry.** Structured log payloads include Slack question snippets (first 100 chars), tool input parameters, and GitHub repo paths. `sendDefaultPii` is off by default so IP and user-agent are NOT attached. If your compliance posture forbids this data leaving your tenant, you must (a) remove the hardcoded DSN fallback in the three Sentry config files and leave `SENTRY_DSN` unset so `Sentry.init` receives no DSN and becomes a no-op, (b) self-host Sentry via their on-prem offering, or (c) add a redaction layer inside `src/lib/logger.ts` before the `console.log` call. Simply unsetting `SENTRY_DSN` without removing the fallback will NOT stop data egress.

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

Every call goes through one code path — `console.log` (or `console.error` for events containing "error") with a JSON payload. In prod with a DSN configured, Sentry's `consoleLoggingIntegration` captures each call and ships it to the Logs UI; in local dev/CI the integration is a silent no-op and logs only reach stdout. Either way, the application code is the same.

Sentry init lives in `sentry.server.config.ts` (project root) and is loaded via `instrumentation.ts` on the Node runtime. See those files for tunable options (`SENTRY_TRACES_SAMPLE_RATE`, etc.).
