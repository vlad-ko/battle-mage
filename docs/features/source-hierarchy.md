# Source-of-Truth Hierarchy

Battle Mage draws from multiple information sources when answering questions. These sources have different reliability levels. The hierarchy defines which source to trust when they conflict.

## The Five Levels

| Rank | Source | Trust Level | Description |
|------|--------|-------------|-------------|
| 1 | **Source code** | Highest | The actual implementation. Code is the ultimate source of truth. |
| 2 | **Tests** | High | Encode expected behavior. If tests pass, the tested behavior is correct. |
| 3 | **Documentation** | Medium | Describes intent but can drift from reality. |
| 4 | **Knowledge base** | Low-medium | User corrections from Slack. Useful but can become outdated as code changes. |
| 5 | **Feedback signals** | Lowest | Thumbs up/down reactions. Subjective quality preferences. |

## How It Works in Practice

### Code vs. Documentation

If the bot reads a file and sees that `authenticate()` accepts two parameters, but the README says it accepts three, the bot should:

1. Trust the code (2 parameters)
2. Flag the discrepancy: "Note: the README says `authenticate()` takes three parameters, but the current code only accepts two. The documentation may be outdated."

### Code vs. Knowledge Base

If a KB entry says "The auth module lives in `app/Services/Auth`" but the bot searches and finds it at `app/Auth`, the bot should:

1. Trust the code (`app/Auth`)
2. Flag the stale KB entry: "Note: the knowledge base says auth is in `app/Services/Auth`, but I found it at `app/Auth`. The KB entry may be outdated."

The bot is explicitly told: **never silently prefer a lower-ranked source over a higher-ranked one.**

### Tests as Behavioral Truth

Tests occupy the second rank because they encode the team's expectations about how code should behave. If a function's docstring says it returns a list, but tests assert it returns a dict, the tests are more likely to be correct (assuming they pass).

### Feedback as Calibration Only

Feedback (thumbs up/down) is the weakest signal. It reflects subjective preferences about answer quality, not factual truth. The system prompt explicitly labels it:

> This is the weakest, most subjective signal -- use it to calibrate tone and style, not as a source of factual truth.

## Conflict Detection Rules

The system prompt includes three specific rules for handling conflicts:

1. **For code-level questions, always read the actual code** before asserting anything from docs, KB, or memory.

2. **When you find a discrepancy**, include both the code truth and the stale source in your answer so the user can decide what to update.

3. **Never silently prefer a lower-ranked source** over a higher-ranked one.

## How This Manifests in the System Prompt

The hierarchy is injected as a numbered list in the system prompt under the heading "Source-of-Truth Hierarchy":

```
1. *Source code* -- The actual implementation. Code is the ultimate source
   of truth. Always verify claims against the code before asserting them.
2. *Tests* -- Encode expected behavior. If tests pass, the tested behavior
   is correct.
3. *Documentation* (docs/, CLAUDE.md, README) -- Describes intent but can
   drift from reality. If documentation contradicts code, trust the code
   and flag the stale documentation.
4. *Knowledge base* (Vercel KV corrections) -- User corrections from Slack.
   Useful but can become outdated as code changes. If a KB entry contradicts
   what you see in the code, the code is authoritative.
5. *Feedback signals* (thumbs up/down reactions) -- The least authoritative
   signal. Subjective quality preferences.
```

Additionally, the knowledge base data section includes a staleness warning, and the feedback section is labeled as "the weakest, most subjective signal."

## Integration with Auto-Correction

When a user thumbs-down an answer, the [auto-correction system](./auto-correction.md) uses the hierarchy implicitly:

- KB entries that share keywords with the answer's references are presumed stale and removed
- Documentation files referenced in the answer are flagged as potentially outdated

This creates a self-correcting loop: the bot answers using KB + docs, the user signals the answer was wrong, and the system removes the lower-ranked sources that may have contributed to the bad answer.

## Alignment with Reference Ranking

The source-of-truth hierarchy is mirrored in how references are displayed to the user. The `rankReferences()` function in `src/lib/references.ts` scores each reference by its type:

- Source code files: 50 points (highest — code is truth)
- Test files: 40 points
- Any ref cited in the answer text: +20 bonus
- Documentation: 10 points
- Uncited list results: 0 points

This means the user sees source code at the top of the reference list and uncited issues at the bottom — reinforcing which sources the answer is grounded in.

## Testing

The hierarchy behavior is tested in `src/lib/claude.test.ts`. Tests verify that:

- All five levels appear in the correct order
- The prompt instructs the bot to flag code-vs-KB discrepancies
- The prompt instructs the bot to flag code-vs-docs discrepancies
- The prompt instructs the bot to verify code before asserting KB/doc claims
- The knowledge section warns about staleness
- The feedback section is labeled as the weakest signal
