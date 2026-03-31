# Auto-Correction

When a user reacts with :thumbsdown: to a bot answer, the auto-correction system analyzes the answer's context and guides the user through providing a correction.

## Overview

The flow:

1. User thumbs-down a bot message
2. Route handler fetches the Q&A context (stored in KV when the answer was posted)
3. Route handler fetches all current KB entries
4. `buildCorrectionActions()` analyzes references and KB entries
5. Possibly related KB entries are **flagged** to the user (not auto-removed)
6. Stale doc references are flagged to the user
7. A pending correction state is stored in KV for this thread
8. Bot replies listing flagged items and asks "What was wrong?"
9. The user's next reply is saved directly to the knowledge base (not through the agent loop)
10. Negative feedback entry is recorded with the actual correction text

## How Stale KB Entries Are Identified

The heuristic is keyword matching between the answer's references and KB entry text.

### Step 1: Extract Keywords from References

When the bot answered the question, it collected references -- the file paths it actually read. The auto-correction system extracts meaningful keywords from those paths:

```
Reference: "src/services/auth/login.ts"
Keywords:  ["src", "services", "auth", "login"]
```

Keywords are extracted by:
1. Replacing non-alphanumeric characters with spaces
2. Splitting camelCase and PascalCase (`LoginService` becomes `Login Service`)
3. Splitting on whitespace
4. Filtering out words shorter than 3 characters
5. Lowercasing everything

### Step 2: Match Against KB Entries

Each KB entry's text is tokenized the same way. If any token in the KB entry matches a keyword from the references (excluding common stop words like "the", "is", "in", "not", "and"), the entry is flagged as possibly related.

Example:

```
References: ["src/controllers/AuthController.ts"]
  -> keywords: ["src", "controllers", "auth", "controller"]

KB entry: "Auth uses JWT tokens, not session cookies"
  -> tokens: ["auth", "uses", "jwt", "tokens", "not", "session", "cookies"]

Match: "auth" appears in both -> entry flagged
```

### Step 3: Flag for User Review (NOT auto-remove)

Flagged KB entries are shown to the user but **not automatically removed**. This is a deliberate design choice -- a thumbs-down might mean the answer was formatted badly, or the question was misunderstood, not necessarily that the KB entries are wrong.

The user sees the flagged entries and can reply to confirm which (if any) should be removed.

## How Doc References Are Flagged

If the answer referenced documentation files (paths ending in `.md` or starting with `docs/`), those are flagged as potentially outdated:

```
Docs referenced: `docs/auth-guide.md`
```

## Pending Correction State

When a 👎 is received, a `pending-correction` key is stored in KV with a 24-hour TTL:

```json
{
  "question": "how does auth work?",
  "references": ["src/services/auth/login.ts"],
  "flaggedKB": ["Auth uses JWT tokens, not session cookies"]
}
```

This state is checked in the thread follow-up handler. When detected, the user's next reply is saved directly to the knowledge base via `saveKnowledgeEntry()` -- it does NOT go through the full agent loop. This ensures corrections are captured as KB entries, not treated as new questions.

After saving, the pending state is cleared and a negative feedback entry is written with the actual correction text.

## The Correction Actions Structure

`buildCorrectionActions()` returns a `CorrectionActions` object:

```typescript
interface CorrectionActions {
  kbEntriesToFlag: KnowledgeEntry[];  // KB entries to show the user
  docsToProposeFix: string[];         // doc paths to flag
  hasActions: boolean;                // true if either array is non-empty
}
```

This is a pure function -- it takes references and KB entries as input and returns actions as output. The actual KV writes and Slack replies happen in the route handler.

## What the User Sees

When a user thumbs-down an answer that referenced auth files and the KB had a matching auth entry:

```
:thinking_face: Thanks for the feedback.

Possibly related KB entries (reply to confirm removal):
  • "Auth uses JWT tokens, not session cookies"

Docs referenced: `docs/auth-guide.md`

What was wrong? Reply here and I'll save the correction.
```

The user replies with the correction:

```
User: Auth actually uses session cookies now, we switched in v4
Bot: :white_check_mark: Saved to knowledge base: "Auth actually uses session cookies now, we switched in v4"
```

If there are no flagged items, the user sees a simpler message:

```
:thinking_face: Thanks for the feedback.

What was wrong? Reply here and I'll save the correction.
```

## Why Flag Instead of Auto-Remove?

The keyword matching heuristic is deliberately broad. It can produce false positives:

- A KB entry about "AuthController response format" would be flagged if the answer referenced any auth file, even if the KB entry is still correct.

Auto-removing on a false positive would destroy valid knowledge. By flagging instead, the user stays in control -- they confirm what's actually wrong, and the correction is specific and meaningful.

## Testing

The auto-correction logic is tested in `src/lib/auto-correct.test.ts`. All three exported functions are pure (no KV, no side effects) and tested with various scenarios:

- KB entries matching referenced file paths
- KB entries matching by topic keyword (not exact path)
- No matches (empty actions)
- Doc file references detected and flagged
- Both KB flags and doc flags in the same correction
- The `hasActions` flag
