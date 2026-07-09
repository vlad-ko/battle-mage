# Behavior Evals (record/replay)

Full-turn behavioral tests that run the REAL production turn code
(`turn-runner` → `claude` → tools → `slack.ts` helpers) against a fully
controlled world, and assert the product's behavioral contracts:

- **Thread-only** — the bot never posts at channel root (auto-applied to
  every scenario).
- **Issue creation requires approval** — a proposal turn makes zero
  GitHub writes; approval creates exactly once; a double-approve loses
  the del-claim race and creates nothing.
- **Silent decline** — a follow-up the classifier rejects produces ZERO
  Slack writes AND an explicit `followup_reply_declined` event (a crash
  is not a decline). All three decline reasons are covered:
  `not_addressed`, `low_confidence`, `classifier_unavailable`.
- **Reference cap** — no message carries more than 7 reference bullets.

See epic #128 / issue #137.

## How to run

```bash
npm run eval:behavior          # replay committed cassettes — keyless, fast, deterministic
npm run eval:behavior:record   # re-record against live Anthropic + GitHub (local only)
```

Replay needs NO credentials: every external interaction is served from a
committed cassette. Re-recording needs `ANTHROPIC_API_KEY`,
`GITHUB_PAT_BM`, `GITHUB_OWNER`, `GITHUB_REPO` in the environment, and an
en-US locale (`LANG=en_US.UTF-8`) — the harness asserts this up front
because the system prompt interpolates `toLocaleString()`.

Re-record a single scenario:

```bash
RECORD=1 npm run eval:behavior -- -t "issue-approval-reaction"
```

## Architecture

```
src/evals/behavior/
  harness/
    cassette.ts     — canonical-JSON sha256 hashing, per-hash FIFO replay
                      matching, Anthropic volatile-field stripping,
                      record blocklist + CI guard (unit-tested in npm test)
    contracts.ts    — {pass, detail} contract assertions (rubric.ts idiom)
    fake-slack.ts   — in-memory WebClient stand-in; slack.ts runs REAL
    fake-kv.ts      — in-memory kv fake (Redis DEL/NX semantics)
    scenario.ts     — mock wiring + step dispatch + cassette I/O
  scenarios/        — *.test.ts, run ONLY under vitest.behavior.config.ts
  cassettes/        — committed recordings, one JSON per scenario
```

### Boundary treatment

| Boundary | Treatment |
|---|---|
| `@slack/web-api` WebClient | ALWAYS in-memory fake — never recorded, never live (I6) |
| `@anthropic-ai/sdk` (claude.ts / effort-routing.ts / compaction.ts singletons) | cassette-backed |
| `@/lib/github` (semantic `{fn, args}` entries) | cassette-backed; `createIssue` blocklisted at record → synthetic response marked `"synthetic": true` (I6) |
| `@/lib/vector` | fake store via `__setVectorStoreFactoryForTests`; vector env force-unset in both modes |
| `@/lib/kv` | in-memory fake (scenario-local state) |
| `@/lib/logger` | captured into `world.logEvents` |
| Date | `vi.useFakeTimers({ toFake: ["Date"] })` pinned to the cassette's `pinnedNow`; real timers stay live for throttle/timeout paths |

### Matching model

Requests are hashed with sha256 over canonical JSON (recursively sorted
object keys, array order preserved). Entries replay from **per-hash FIFO
queues** — Claude dispatches independent tool calls in parallel, so
identical requests can repeat and cross-hash arrival order is not
deterministic, but order within one hash is. Anthropic RESPONSES are
stripped of volatile fields before recording (`id` → `msg_cassette`,
`_request_id` dropped) while `content`, `stop_reason`, `usage` and
tool_use block ids are preserved verbatim — tool_use ids are echoed into
the next request and therefore into its hash. Requests are never stripped.

A replay miss throws `CassetteMissError` with the scenario id, request
hash, a summary diff against the nearest unconsumed recording, and the
literal re-record command. **Replay never falls back to a live call** (I5).

### Invariants

- **I5** — replay is hermetic; a cassette miss is a hard failure.
- **I6** — Slack is always fake; `createIssue` never reaches GitHub at
  record time (synthetic response, `"synthetic": true` in the cassette).
- **I7** — `RECORD=1` with `CI` set throws; recording is a deliberate
  local act.

### Synthetic boundary twins

Some classifier verdicts can't be reliably produced by a live model (an
exact 0.74 confidence, a malformed payload). Scenarios declare
`recordOverrides` — the matching request is not sent live; the crafted
response is recorded with `"synthetic": true`, the same mechanism as the
`createIssue` blocklist.

## CI

`.github/workflows/behavior-evals.yml` runs replay keyless on PRs that
are labeled `behavior-evals` or touch `src/evals/behavior/**` /
`vitest.behavior.config.ts`. It is NOT a required check (it deliberately
skips on most PRs) and carries no API secrets. `ci.yml` is untouched;
the harness unit tests under `harness/*.test.ts` run in the normal
`npm test` suite there.

## When a scenario fails

1. **CassetteMissError** — production code now issues a request the
   cassette doesn't have (prompt change, new tool call, changed tool
   input). If intentional, re-record the named scenario and review the
   cassette diff like source.
2. **Contract failure** — replay matched but behavior diverged (e.g. a
   root post, a second createIssue). That is the regression the suite
   exists to catch — fix the code, not the cassette.
