# Telemetry — incident-response reference

This is the **incident-response view** of Battle Mage's telemetry: the stable event vocabulary you can build alerts and dashboards on, plus ready-made Sentry query recipes. The full event **catalog** (every event, every field) and the plumbing (Sentry setup, the `after()` tail-drop rule, KV-op schema) live in [docs/observability.md](docs/observability.md) — this file deliberately does not duplicate it.

Split of responsibilities:

- **docs/observability.md** — catalog + plumbing: what each event carries, how logs reach Sentry, how to debug the pipeline itself.
- **TELEMETRY.md** (this file) — incident response: which events are load-bearing, what "healthy" looks like, and the queries to run when it isn't.

All events are structured JSON logs correlated by `requestId` (see docs/observability.md). Event names containing `error` or `failed` route to `console.error` → Sentry error severity.

## Stable event vocabulary

These names are treated as a public contract — renaming one is a breaking change for dashboards and must be called out in the PR (the last rename wave was #125).

### Turn lifecycle

| Event | Meaning |
|---|---|
| `mention_start` | An @bm mention was accepted for processing |
| `thread_followup_start` | A thread follow-up was accepted for processing |
| `answer_posted` | The final answer landed in Slack |
| `agent_turn_failed` | A mention/follow-up turn died with a handled error (`flow: mention \| thread_followup`) |
| `webhook_handler_failed` | A reaction handler died (`flow: reaction_checkmark \| reaction_thumbsup \| reaction_thumbsdown`) |
| `tool_call_failed` | A tool executor threw mid-agent-loop (`tool`, `round`, `errorMessage`) |
| `turn_end` | Log-flush canary — if this appears, no earlier log in the turn was dropped |

### Idempotency (issue creation, #125)

| Event | Meaning |
|---|---|
| `idempotency_replayed` | Duplicate issue creation suppressed; recorded result reused |
| `idempotency_in_flight` | Concurrent creation of identical content detected and refused |
| `idempotency_degraded` | KV unreachable — creation ran unguarded (fail open) |

### Recovery (processing markers + cron sweep, #125)

| Event | Meaning |
|---|---|
| `recovery_marker_write_failed` | Turn started without crash protection |
| `recovery_marker_clear_failed` | Marker cleanup failed (self-heals via sweep guard / 24 h TTL) |
| `recovery_sweep_retried` | A died turn was re-run |
| `recovery_sweep_already_answered` | Died AFTER answering — marker cleaned, no retry |
| `recovery_sweep_gave_up` | Retry also died — user got a visible failure notice |
| `recovery_marker_orphaned` | Index entry outlived its marker record — dropped |
| `recovery_sweep_claim_lost` | Another sweep instance owns this member's NX claim (`processing:claim:*`, 120 s TTL) — benign skip |
| `recovery_sweep_complete` | Sweep heartbeat (`scanned`, `retried`, `gaveUp`, `orphaned`) |
| `recovery_sweep_failed` / `recovery_sweep_member_failed` | The sweep itself broke (whole run / one thread — state stays recoverable; the next sweep retries after the claim TTL) |
| `recovery_sweep_unauthorized` | Cron auth rejected — check `CRON_SECRET` |

### Code index (incremental source embedding, #135)

| Event | Meaning |
|---|---|
| `src_index_tick` | Indexing-tick heartbeat (`status`, `upserted`, `deleted`, `skipped`, `remaining`) |
| `src_index_noop` | Head SHA already indexed — the healthy steady state |
| `src_index_tree_truncated` | GitHub truncated the tree listing — tick aborted before any delete (mass-delete guard) |
| `src_index_file_skipped` | One unreadable file skipped — retried next tick |
| `src_index_degraded` | Vector layer failed mid-tick — progress persisted, SHA not advanced |
| `src_index_tick_failed` | The tick itself threw (KV/infrastructure) — Sentry issue tagged `flow: cron_code_index` |
| `src_index_claim_lost` | Another tick owns the NX claim (`srcindex:claim`, 270 s TTL) — benign skip |
| `src_index_unauthorized` | Cron auth rejected — check `CRON_SECRET` |

## Query recipes (Sentry Logs UI)

### Turn failure rate

Handled failures as a share of accepted mentions:

```
count(event:agent_turn_failed flow:mention) / count(event:mention_start)
```

Healthy: low single-digit percent, dominated by transient GitHub/Anthropic errors. A spike with a constant `message` is a code bug — the Sentry Issue (captured alongside the log) has the stack trace. **Silent** failures (container death) never emit `agent_turn_failed` — they show up in the recovery funnel below instead. The follow-up variant is the same query with `flow:thread_followup` over `thread_followup_start`.

### Recovery funnel

How many turns died silently, and what happened to them:

```
event:recovery_sweep_retried            — died once, re-run
event:recovery_sweep_gave_up            — died twice, user notified
event:recovery_sweep_already_answered   — died post-answer, benign
event:recovery_marker_orphaned          — bookkeeping cleanup, benign
```

Healthy: all four near zero; `recovery_sweep_complete` appearing every ~5 minutes with `scanned: 0`. Rising `retried` means containers are dying mid-turn (check function duration/memory). Any `gave_up` deserves a look at the thread — the same question killed two runs, which usually means a pathological input. `recovery_sweep_complete` **missing** means the cron isn't firing: check the Vercel Cron dashboard and look for `recovery_sweep_unauthorized`.

### Duplicate-suppression rate

How often idempotency actually saved us from a duplicate GitHub issue:

```
count(event:idempotency_replayed) + count(event:idempotency_in_flight)
```

…as a share of `event:issue_batch_confirmed`. Healthy: near zero in steady state (the del-claim + tombstone layer catches most races first). A sustained rise means duplicate confirmations are reaching the innermost layer — look for Slack event redeliveries (`x-slack-retry-num` handling) or tombstone-TTL gaps. Any nonzero `idempotency_degraded` means Upstash was unreachable during issue creation — correlate with `kv_error`.

### Code-index health

Is the source index keeping up with the repo?

```
event:src_index_noop           — steady state (head SHA fully indexed)
event:src_index_tick           — catching up (status: complete | partial | degraded)
event:src_index_tick_failed    — the tick itself broke
```

Healthy: mostly `src_index_noop` every ~5 minutes, with short bursts of `src_index_tick status:partial → complete` after pushes. Persistent `partial` with a non-shrinking `remaining` means the per-tick budgets can't keep up (or one file keeps failing — check `src_index_file_skipped` for a repeated `path`). Any `src_index_degraded` correlates with `vector_error`; `src_index_tree_truncated` on a huge repo means the recursive tree API is truncating and the index cannot safely advance. A **missing** heartbeat means the cron isn't firing — check the Vercel Cron dashboard and look for `src_index_unauthorized`.

### Cross-run correlation

A sweep retry logs the dead run's ID as `originalRequestId` on `recovery_sweep_retried`. To reconstruct an incident: filter the original `requestId` for the death context, then the sweep's `requestId` for the retry outcome.
