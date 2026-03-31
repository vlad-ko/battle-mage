# Contributing Guide

Battle Mage is an open-source project. Contributions are welcome -- but the project has specific standards around testing, code structure, and quality. Read this before opening a PR.

## Getting Started

```bash
# Fork and clone
git clone https://github.com/your-username/battle-mage.git
cd battle-mage

# Install dependencies
npm install

# Copy environment template
cp .env.example .env.local
# Fill in credentials (see docs/setup.md)

# Run tests
npm test

# Start dev server
npm run dev
```

## TDD Is Mandatory

Every new feature and bug fix must follow test-driven development:

### RED

Write the failing test first. Define what the code should do before writing any implementation.

```typescript
// src/lib/my-feature.test.ts
import { describe, it, expect } from "vitest";
import { myFunction } from "./my-feature";

describe("myFunction", () => {
  it("returns the expected result", () => {
    expect(myFunction("input")).toBe("expected output");
  });
});
```

Run `npm test` -- the test should fail (because `myFunction` does not exist yet).

### GREEN

Write the minimum code to make the test pass.

```typescript
// src/lib/my-feature.ts
export function myFunction(input: string): string {
  return "expected output";
}
```

Run `npm test` -- the test should pass.

### REFACTOR

Clean up the implementation while keeping tests green. Run `npm test` after every change.

### Test Infrastructure

- **Framework**: Vitest
- **Config**: `vitest.config.ts` with `@` path alias resolution
- **Colocated**: test files live next to source files (`foo.ts` -> `foo.test.ts`)
- **Run all tests**: `npm test` (single run, CI mode)
- **Watch mode**: `npm run test:watch` (re-runs on file changes)
- **Current count**: 113 tests across 7 test files

### What to Test

The project follows a pattern of extracting pure functions for testability and keeping side effects in the handler layer.

**Test these** (pure functions):
- System prompt assembly (`assembleSystemPrompt`)
- Topic classification (`classifyTopics`, `buildIndexSummary`)
- Stale entry detection (`identifyStaleKBEntries`, `buildCorrectionActions`)
- Message formatting (`formatProgressMessage`, `buildThinkingMessage`)
- Markdown conversion (`toSlackMrkdwn`)
- Reference formatting (`formatReferences`)
- Issue proposal parsing (`parseProposalFromMessage`)

**Do not test directly** (side-effect layer):
- The route handler (`route.ts`) -- it orchestrates side effects (Slack API, GitHub API, KV)
- KV read/write operations -- these are integration concerns
- GitHub API calls -- these depend on external services

If your feature requires external calls, extract the logic into a pure function that can be tested in isolation, and call that function from the handler.

## CI Pipeline

Every pull request runs the CI pipeline on GitHub Actions:

```yaml
steps:
  - Checkout
  - Setup Node.js 22 with npm cache
  - npm ci
  - Typecheck (tsc --noEmit)
  - Test (vitest run)
  - Build (next build)
```

All three checks must pass:

1. **Typecheck** -- no TypeScript errors
2. **Test** -- all 100+ tests pass
3. **Build** -- the Next.js app compiles successfully

CI runs on:
- Every push to `main`
- Every pull request targeting `main`

### Branch Protection

The `main` branch requires:
- CI status checks to pass before merging
- Pull request review (depending on repo settings)

Do not push directly to `main`. Always use a feature branch and PR.

## Fork Workflow

1. **Fork** the repository on GitHub
2. **Clone** your fork locally
3. **Create a feature branch**: `git checkout -b feat/my-feature`
4. **Write tests first** (RED)
5. **Implement** (GREEN)
6. **Refactor** while tests stay green
7. **Run the full suite**: `npm test && npm run typecheck`
8. **Commit** with a descriptive message
9. **Push** to your fork: `git push origin feat/my-feature`
10. **Open a PR** against `main`

### Commit Message Convention

Use conventional-style prefixes:

- `feat:` -- new feature
- `fix:` -- bug fix
- `test:` -- adding or updating tests
- `docs:` -- documentation changes
- `refactor:` -- code restructuring without behavior change

Examples:
```
feat: Add list_commits tool for recent commit history
fix: Handle empty KB entries in auto-correction
test: Add edge cases for mrkdwn heading conversion
refactor: Extract keyword matching into pure function
```

## What Makes a Good Contribution

### Good Contributions

- **New tools**: Adding a tool for a new GitHub API (e.g., `list_releases`, `get_workflow_runs`). Follow the existing pattern: tool definition + execute function + tests.
- **Better classification**: Improving the repo index topic rules to catch more patterns.
- **Mrkdwn improvements**: Handling more Markdown-to-Slack conversions (e.g., tables, strikethrough).
- **Bug fixes**: Fixing edge cases in existing functionality, especially with tests that reproduce the bug.
- **Test coverage**: Adding tests for untested edge cases in existing pure functions.

### Contributions to Avoid

- **Large refactors without tests**: If you want to restructure something, write tests for the current behavior first, then refactor.
- **Adding dependencies**: The project intentionally has a small dependency footprint. If you want to add a dependency, open an issue first to discuss.
- **Changing the system prompt without tests**: The system prompt is tested. Changes to prompt behavior should be accompanied by test updates.
- **Breaking the pure/side-effect boundary**: Keep pure functions pure. Do not add KV or API calls to modules that are currently testable without mocks.

## Project Structure

```
src/
  app/
    api/slack/route.ts    -- Webhook handler (side-effect layer)
    page.tsx              -- Landing page
  lib/
    claude.ts             -- System prompt + agent loop
    claude.test.ts        -- 30+ tests for prompt assembly
    slack.ts              -- Slack API helpers
    github.ts             -- GitHub API helpers
    knowledge.ts          -- KV knowledge base
    feedback.ts           -- KV feedback storage
    repo-index.ts         -- Topic classification
    repo-index.test.ts    -- Classification tests
    auto-correct.ts       -- Stale entry detection
    auto-correct.test.ts  -- Auto-correction tests
    progress.ts           -- Progress message formatting
    progress.test.ts      -- Progress formatting tests
    mrkdwn.ts             -- Markdown to Slack converter
    mrkdwn.test.ts        -- Conversion tests
    references.ts         -- Reference formatting
    references.test.ts    -- Reference tests
  tools/
    index.ts              -- Tool registry + executor
    search-code.ts        -- search_code tool
    read-file.ts          -- read_file tool
    list-issues.ts        -- list_issues tool
    list-commits.ts       -- list_commits tool
    list-prs.ts           -- list_prs tool
    create-issue.ts       -- create_issue tool
    create-issue.test.ts  -- Proposal parsing tests
    save-knowledge.ts     -- save_knowledge tool
```

## Local Development Tips

- Use `npm run test:watch` during development -- it re-runs affected tests on save.
- You do not need Slack, GitHub, or KV credentials to run tests. Tests only exercise pure functions.
- For full end-to-end testing, you need all environment variables set and a tunnel (like ngrok) to expose your local server to Slack.
- The dev server runs at `http://localhost:3000`. The landing page shows basic project info.

## Questions?

Open a GitHub issue with the `question` label. We are happy to help with setup issues, architectural questions, or contribution guidance.
