# Path Annotations (.battle-mage.json)

Battle Mage can read a `.battle-mage.json` configuration file from the root of your target repo. This file tells the agent how to treat different areas of your codebase — which paths are primary source code, which are archived history, which are third-party vendor code, and which should be completely ignored.

## Why This Matters

Without configuration, the agent treats every file equally. It might read archived docs from 2024 and present them as current, or dive into vendor code when you asked about your own auth module. Path annotations give you control over what the agent prioritizes, what it skips, and how it qualifies information from different sources.

## Creating the Config File

Add a `.battle-mage.json` file to the root of your **target repo** (the repo Battle Mage reads — not the Battle Mage repo itself):

```json
{
  "paths": {
    "src/": "core",
    "app/": "core",
    "tests/": "core",
    "config/": "core",
    "database/migrations/": "core",
    "docs/": "current",
    "docs/archive/": "historic",
    "docs/2025-historical/": "historic",
    "vendor/": "vendor",
    "node_modules/": "excluded",
    "storage/": "excluded",
    "public/build/": "excluded",
    ".terraform/": "excluded"
  }
}
```

Commit this file to the repo. Battle Mage reads it via the GitHub API on each index rebuild — no deploy or restart needed.

## Annotation Types

| Annotation | Trust Level | What it means |
|-----------|------------|---------------|
| `core` | **Highest** | Primary source code, configuration, and tests. The agent reads these first and gives them the highest weight in answers. |
| `current` | **Normal** | Up-to-date content that is trustworthy but not primary source code. This is the default for unannotated paths. |
| `historic` | **Low** | Archived or outdated content. The agent skips these by default and only reads them when the question is explicitly about history or past decisions. When citing historic content, the agent qualifies it as "historically..." |
| `vendor` | **Low** | Third-party or external code. The agent skips these by default and only reads them when the question is about dependencies or library behavior. When citing vendor code, the agent qualifies it as third-party. |
| `excluded` | **None** | Completely invisible to the agent. Never indexed, never read, never referenced. Use for generated files, build artifacts, or sensitive paths. |

## How Prefix Matching Works

Paths are matched by prefix. `"docs/"` matches everything under the `docs/` directory. More specific paths override less specific ones:

```json
{
  "paths": {
    "docs/": "current",
    "docs/archive/": "historic"
  }
}
```

With this config:
- `docs/setup.md` → `current` (matches `docs/`)
- `docs/archive/old-notes.md` → `historic` (matches `docs/archive/`, which is more specific)
- `README.md` → `current` (no match — defaults to `current`)

The matching algorithm finds the **longest matching prefix**. This means you can set a broad default and then override specific subdirectories.

## How Annotations Affect the Agent

### 1. Repo Index

When the repo index is built (lazily, on first query after a push), annotations control how files are classified:

- `excluded` paths are filtered out entirely — they never appear in the index
- `historic` paths are grouped into a `_historic` pseudo-topic with the hint: "use only for history questions"
- `vendor` paths are grouped into a `_vendor` pseudo-topic with the hint: "use only for dependency questions"
- `core` and `current` paths are classified into normal topics (authentication, deployment, database, etc.)

The agent sees the index in its system prompt and knows which areas to search first.

### 2. System Prompt

When annotations exist, a "Path Annotations" section is injected into the system prompt:

```
## Path Annotations (from .battle-mage.json)

The team has annotated paths in this repo with trust levels:
- *core*: src/, app/, tests/, config/
- *current*: docs/
- *historic*: docs/archive/, docs/2025-historical/
- *vendor*: vendor/

Rules:
- Prefer core paths as primary evidence — read these first
- current paths have normal trust — standard behavior
- Skip historic paths unless the question is about history...
- Skip vendor paths unless the question is about dependencies...
- Never read or reference excluded paths
```

This directly instructs the agent on how to prioritize different paths.

### 3. Search Strategy

The search strategy rules in the system prompt already instruct the agent to search before reading and budget tool rounds. With annotations, the agent additionally:

- Starts with `core` paths when looking for code
- Skips `historic` and `vendor` paths unless the question is specifically about history or dependencies
- Never reaches for `excluded` paths

### 4. Reference Ranking

References in the answer footer are ranked by the source-of-truth hierarchy. Annotations adjust the scores:

| Annotation | Score adjustment | Effect |
|-----------|-----------------|--------|
| `core` | +10 | Ranks higher than non-annotated files of the same type |
| `current` | 0 | No change |
| `historic` | -20 | Sinks below uncited issues (which score 0) |
| `vendor` | -20 | Same as historic |

This ensures that if a historic doc accidentally gets cited, it appears near the bottom of the reference list — signaling to the user that the source has low trust.

### 5. Answer Construction

When the agent cites content from annotated paths, it adjusts its language:

- **core**: No qualifier needed — this is the primary source
- **current**: No qualifier needed — standard trust
- **historic**: "Historically, the approach was..." or "In the archived docs..."
- **vendor**: "The third-party library provides..." or "In the vendor code..."

This prevents the agent from presenting archived content as current fact.

## Defaults

If `.battle-mage.json` does not exist, the agent falls back to hardcoded exclusions:

```
vendor/, node_modules/, .git/, dist/, build/
```

All other paths default to `current` (normal trust). The agent works fine without a config file — the config just makes it smarter about your specific codebase.

## Invalid Config

If the config file exists but contains invalid JSON, the agent logs a warning and proceeds with defaults. No error is shown to the user. Invalid annotation values (anything other than `core`, `current`, `historic`, `vendor`, `excluded`) are silently ignored.

## Tips

1. **Start simple.** You don't need to annotate every path. Start with `excluded` for obvious noise (node_modules, build artifacts) and `historic` for archived docs. Add more annotations as you notice the agent making wrong choices.

2. **Use `historic` for old docs, not `excluded`.** Excluded paths are invisible — the agent can never reference them, even if asked. Historic paths are deprioritized but still accessible for history questions.

3. **`core` is for emphasis.** If you don't annotate anything as `core`, everything defaults to `current` and the agent treats all paths equally. Use `core` to tell the agent "this is where the important code lives."

4. **Specificity wins.** You can annotate `vendor/` as `vendor` and then override a specific vendored tool with `vendor/our-internal-tool/: "core"` if you maintain it yourself.

## Testing

The config system is tested in `src/lib/config.test.ts` (15 tests) covering:
- JSON parsing (valid, null, invalid, missing paths, invalid annotations)
- Prefix matching (exact, longest match, unannotated, nested)
- Path filtering (single exclusion, multiple, empty config, order preservation)

Integration with the repo index is tested in `src/lib/repo-index.test.ts` (6 tests) covering:
- Excluded paths filtered from index
- Historic paths routed to `_historic` pseudo-topic
- Vendor paths routed to `_vendor` pseudo-topic
- Core/current paths classified normally

Prompt injection and reference ranking are tested in `src/lib/claude.test.ts` (5 tests) and `src/lib/references.test.ts` (3 tests).
