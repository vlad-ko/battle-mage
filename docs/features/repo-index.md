# Repository Index

The repository index is an auto-generated topic map of your codebase. It helps the bot jump directly to relevant files instead of searching blind.

## How It Works

When the bot starts processing a question, it calls `getOrRebuildIndex()` which:

1. Fetches the current HEAD SHA from the main branch
2. Compares it against the stored SHA in Vercel KV
3. If they match, returns the cached index summary
4. If they differ (new commits since last build), rebuilds the index

### Lazy Rebuild

The index is only rebuilt when the repo has changed. This means:

- **First question after a push**: index rebuilds (adds a few hundred milliseconds)
- **Subsequent questions on the same SHA**: index served from KV cache (fast)
- **No background jobs**: the rebuild happens lazily on the next request

If the rebuild fails for any reason (GitHub API error, KV timeout), the bot falls back to an empty index and relies on `search_code` instead. The index is a performance optimization, not a hard dependency.

## Topic Classification

The index works by fetching the full file tree from GitHub (via `git.getTree` with `recursive: true`) and classifying each file path against a set of heuristic rules.

### Classification Rules

Each rule is a `[topic, regex]` pair tested against the file path:

| Topic | Pattern matches |
|-------|----------------|
| `authentication` | auth, login, session, oauth, jwt, token, password, credential |
| `deployment` | dockerfile, docker-compose, deploy, cloud run, kubernetes, k8s, helm |
| `database` | migration, schema, database, seed, .sql, models/ |
| `testing` | tests, .test., .spec., __tests__, phpunit, jest, vitest |
| `documentation` | .md, docs/ |
| `ci-cd` | .github/workflows/, .circleci, .gitlab-ci, jenkinsfile, buildkite |
| `api` | routes, controller, endpoint, api/ |
| `configuration` | config/, .env, docker-compose, .yml, .json |

A single file can appear in multiple topics. For example, `tests/Auth/LoginTest.php` matches both `testing` and `authentication`.

### Ignored Paths

Files under these prefixes are skipped entirely:

- `vendor/`
- `node_modules/`
- `.git/`
- `dist/`
- `build/`

### Path Capping

Each topic shows at most 8 file paths. If a topic has more files, the summary shows `(+N more)`. This keeps the index concise enough to fit in the system prompt without consuming too many tokens.

## KV Storage

Four keys are stored in Vercel KV:

| Key | Value | Purpose |
|-----|-------|---------|
| `index:sha` | HEAD commit SHA | Staleness check |
| `index:topics` | JSON topic map | Full topic-to-paths mapping |
| `index:summary` | Formatted text | Ready-to-inject prompt section |
| `index:built_at` | ISO timestamp | Debugging/auditing |

## Prompt Injection

When the index is available, it is injected into the system prompt under the heading "Repository Map (auto-generated index)":

```
## Repository Map (auto-generated index)

This map shows the key areas of the repo. Use it to jump directly to
relevant files with `read_file` instead of searching blind. The map
is rebuilt automatically when the repo changes.

- *authentication*: app/Services/Auth/LoginService.php, config/auth.php
- *deployment*: Dockerfile, .github/workflows/deploy.yml
- *testing*: tests/Unit/AuthTest.php, tests/Feature/LoginTest.php (+12 more)
```

This gives the bot a high-level map of the repository so it can use `read_file` directly when it knows which area of the codebase is relevant, saving tool rounds.

## Adding New Topics

To classify new topics, add a `[topic, regex]` entry to the `TOPIC_RULES` array in `src/lib/repo-index.ts`. The regex is tested case-insensitively against the full file path.

Example -- adding a "frontend" topic:

```typescript
["frontend", /\bcomponents?\b|\.tsx$|\.jsx$|pages?\//i],
```

The pure classification functions (`classifyTopics`, `isIndexStale`, `buildIndexSummary`) are exported and tested separately from the KV and GitHub integration. See `src/lib/repo-index.test.ts` for the test suite.
