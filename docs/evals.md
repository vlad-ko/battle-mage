# Eval Harness

A judge-lite, pattern-based eval suite that runs Battle Mage against a set of golden questions and asserts output-contract rubrics. Used to catch quality regressions in prompt changes, model swaps, and agent-loop refactors that unit tests can't see.

## When to run

- Before merging any PR that touches `src/lib/claude.ts` (system prompt, agent loop, model selection).
- Before merging changes to the output contract, banned phrases, or mrkdwn format rules.
- After changing reference ranking, topic pre-matching, or the knowledge base.
- Whenever Anthropic ships a new model version and you want to compare.

## When NOT to run

- In CI on every PR — evals cost money and are slow. Keep them local/on-demand.
- On noisy prompts (e.g. "summarize the whole repo") — pick focused questions where a correct answer is narrow.

## Running

```bash
# Requires real env vars in your shell — same ones battle-mage uses:
export ANTHROPIC_API_KEY=sk-ant-...
export GITHUB_PAT_BM=github_pat_...
export GITHUB_OWNER=vlad-ko
export GITHUB_REPO=battle-mage

npm run eval
```

Evals are serialized and have a 5-minute timeout each (same as the agent's time budget). Expect a full run to take several minutes and cost a few cents of Claude API credit.

## The rubric

Each fixture composes one or more pure scorers from `src/evals/rubric.ts`. The scorers are deterministic and also unit-tested in `src/evals/rubric.test.ts` (which runs in `npm test`).

| Scorer | Checks |
|---|---|
| `hasNoNarration(text)` | No banned phrases like "let me check", "i'll look", "one moment" — mirrors the output-contract ban list |
| `hasNoMarkdownLinks(text)` | No `[label](url)` — Slack renders these literally; must use `<url\|label>` |
| `hasNoDoubleAsterisks(text)` | No `**bold**` — Slack uses single asterisks |
| `hasNoMarkdownTables(text)` | No pipe-syntax tables — Slack breaks them |
| `isWithinCharLimit(text, max)` | Response length below `max` chars |
| `referenceLabelsInclude(refs, substring)` | At least one reference label contains the expected substring |

Each returns `{ pass: boolean, detail?: string }`. The `detail` is propagated into the vitest failure message so you can see *what* regressed without re-running the eval.

## Adding a fixture

1. Create `src/evals/fixtures/<name>.test.ts`. (Eval fixtures use the standard `.test.ts` suffix but live under `src/evals/fixtures/`, which the default `npm test` config excludes — they run only under `npm run eval`.)
2. Import `runEval` and the rubric scorers you need.
3. Write `it(...)` blocks that call `await runEval(question)` and assert rubric results.

Template:

```ts
import { describe, it, expect } from "vitest";
import { runEval } from "../run-eval";
import { hasNoNarration, isWithinCharLimit } from "../rubric";

describe("eval: <what you're measuring>", () => {
  it("short description of the property", async () => {
    const result = await runEval("your question here");
    expect(hasNoNarration(result.text).pass).toBe(true);
    expect(isWithinCharLimit(result.text, 2500).pass).toBe(true);
  });
});
```

### Writing good eval questions

- **Narrow**: pick questions with a correct answer that's grepable or boolean-ish ("is `slack.ts` referenced?"), not open-ended ("tell me about the project").
- **Dogfoods the target repo**: evals target whichever repo `GITHUB_OWNER/GITHUB_REPO` points to — typically battle-mage itself during development.
- **Stable**: avoid questions whose "correct" answer changes frequently (e.g. "what's the latest PR?" — what's "latest" moves).
- **One rubric per property**: don't stuff five assertions into one `it()`; split them so failure messages point at the specific regression.

## Extending the rubric

Add a new scorer to `src/evals/rubric.ts`:

```ts
export function hasReasonableBulletCount(text: string, max: number): RubricResult {
  const bullets = text.split(/\n/).filter((l) => /^\s*[-•]/.test(l)).length;
  if (bullets > max) {
    return { pass: false, detail: `${bullets} bullets exceed limit of ${max}` };
  }
  return { pass: true };
}
```

Then add a unit test in `src/evals/rubric.test.ts` covering a pass case, a fail case, and a boundary case.

## Roadmap

The current harness is pattern-based only. Planned follow-ups tracked separately:

- **Judge-based scoring via Haiku**: a second Claude call rates answers on a 0–5 rubric for subjective qualities (helpfulness, completeness) the patterns can't catch. See issue #85 for context.
- **Automated regression comparison**: run evals on two branches and diff the results.
- **Broader fixtures**: cover compaction, parallel tools, model-split behavior as those features ship.
