# Auto-Correction

When a user reacts with :thumbsdown: to a bot answer, the auto-correction system analyzes the answer's context and takes corrective actions automatically.

## Overview

The flow:

1. User thumbs-down a bot message
2. Route handler fetches the Q&A context (stored in KV when the answer was posted)
3. Route handler fetches all current KB entries
4. `buildCorrectionActions()` analyzes references and KB entries
5. Stale KB entries are removed from KV
6. Stale doc references are flagged to the user
7. Bot replies asking what was wrong

## How Stale KB Entries Are Identified

The heuristic is keyword matching between the answer's references and KB entry text.

### Step 1: Extract Keywords from References

When the bot answered the question, it collected references -- the file paths it actually read. The auto-correction system extracts meaningful keywords from those paths:

```
Reference: "app/Services/Auth/LoginService.php"
Keywords:  ["app", "services", "auth", "login", "service", "php"]
```

Keywords are extracted by:
1. Replacing non-alphanumeric characters with spaces
2. Splitting camelCase and PascalCase (`LoginService` becomes `Login Service`)
3. Splitting on whitespace
4. Filtering out words shorter than 3 characters
5. Lowercasing everything

### Step 2: Match Against KB Entries

Each KB entry's text is tokenized the same way. If any token in the KB entry matches a keyword from the references (excluding common stop words like "the", "is", "in", "not", "and"), the entry is flagged as potentially stale.

Example:

```
References: ["src/controllers/AuthController.ts"]
  -> keywords: ["app", "http", "controllers", "auth", "controller", "php"]

KB entry: "Auth uses JWT tokens, not session cookies"
  -> tokens: ["auth", "uses", "jwt", "tokens", "not", "session", "cookies"]

Match: "auth" appears in both -> entry flagged as stale
```

### Step 3: Remove Stale Entries

Flagged KB entries are removed from the Vercel KV sorted set via `removeKnowledgeEntry()`. This is an exact match on the entry text -- the function scans all members of the sorted set to find and remove the matching one.

## How Doc References Are Flagged

If the answer referenced documentation files (paths ending in `.md` or starting with `docs/`), those are flagged as potentially outdated. The bot does not auto-create issues -- it informs the user:

```
Auto-corrections taken:
- Removed stale KB entry: "Auth uses JWT"
- These docs may be outdated: `docs/auth.md` -- reply "create issue" if
  you'd like me to propose a doc-fix issue
```

This gives the user the choice to file an issue for updating the documentation.

## The Correction Actions Structure

`buildCorrectionActions()` returns a `CorrectionActions` object:

```typescript
interface CorrectionActions {
  kbEntriesToRemove: KnowledgeEntry[];  // KB entries to delete
  docsToProposeFix: string[];           // doc paths to flag
  hasActions: boolean;                  // true if either array is non-empty
}
```

This is a pure function -- it takes references and KB entries as input and returns actions as output. The actual KV writes and Slack replies happen in the route handler.

## What the User Sees

When a user thumbs-down an answer that referenced auth files and the KB had a matching auth entry:

```
:thinking_face: Thanks for the feedback.

Auto-corrections taken:
- Removed stale KB entry: "Auth uses JWT, not session cookies"
- These docs may be outdated: `docs/auth-guide.md` -- reply "create issue"
  if you'd like me to propose a doc-fix issue

What was wrong with this answer? Reply here and I'll save the correction
to my knowledge base.
```

If there are no auto-corrections to take (no matching KB entries, no doc references), the user sees a simpler message:

```
:thinking_face: Thanks for the feedback.

What was wrong with this answer? Reply here and I'll save the correction
to my knowledge base.
```

## Limitations

The keyword matching heuristic is deliberately broad. It can produce false positives:

- A KB entry about "AuthController response format" would be flagged as stale if the answer referenced any auth file, even if the KB entry is still correct.

This is by design. When a user signals an answer was wrong, it is better to be aggressive about removing potentially stale data. The user can re-teach the bot the correct information in the follow-up.

## Testing

The auto-correction logic is tested in `src/lib/auto-correct.test.ts`. All three exported functions are pure (no KV, no side effects) and tested with various scenarios:

- KB entries matching referenced file paths
- KB entries matching by topic keyword (not exact path)
- No matches (empty actions)
- Doc file references detected and flagged
- Both KB removals and doc flags in the same correction
- The `hasActions` flag
