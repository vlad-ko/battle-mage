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

The logger outputs to `console.log` with JSON serialization — Vercel captures this automatically. No external dependencies needed.
