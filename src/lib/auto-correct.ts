import type { KnowledgeEntry } from "./knowledge";

/**
 * Auto-Correction Logic — Pure functions (no KV, no side effects)
 *
 * When a user 👎 an answer, these functions analyze the Q&A context
 * to determine what corrective actions to take:
 * 1. Identify stale KB entries that may have contributed to the bad answer
 * 2. Identify doc files that may need updating
 *
 * The actual KV writes and Slack replies happen in route.ts.
 */

// ── Identify stale KB entries ────────────────────────────────────────
// A KB entry is "stale" if it mentions the same files or topics as the
// answer's references. This is a heuristic — it catches entries like
// "Auth uses JWT" when the answer referenced auth files.

function extractKeywords(path: string): string[] {
  // Extract meaningful words from a file path, splitting camelCase/PascalCase
  return path
    .replace(/[^a-zA-Z0-9]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase → camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // HTMLParser → HTML Parser
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .map((w) => w.toLowerCase());
}

export function identifyStaleKBEntries(
  references: string[],
  kbEntries: KnowledgeEntry[],
): KnowledgeEntry[] {
  if (references.length === 0 || kbEntries.length === 0) return [];

  // Build a keyword set from all referenced file paths
  const refKeywords = new Set<string>();
  for (const ref of references) {
    for (const keyword of extractKeywords(ref)) {
      refKeywords.add(keyword);
    }
  }

  // A KB entry is potentially stale if it shares keywords with the references
  return kbEntries.filter((entry) => {
    const entryWords = entry.entry.toLowerCase().replace(/[^a-zA-Z0-9\s]/g, "").split(/\s+/);
    // Require at least one meaningful keyword match (skip common words)
    const commonWords = new Set(["the", "is", "in", "not", "and", "or", "a", "an", "to", "of", "for", "it", "was", "that", "with"]);
    return entryWords.some(
      (word) => word.length > 2 && !commonWords.has(word) && refKeywords.has(word),
    );
  });
}

// ── Identify doc references that may be stale ────────────────────────
// If the agent referenced docs/markdown files and the answer was wrong,
// those docs might need updating.

export function identifyStaleDocReferences(references: string[]): string[] {
  return references.filter(
    (ref) => ref.endsWith(".md") || ref.startsWith("docs/"),
  );
}

// ── Build correction actions ─────────────────────────────────────────
// Combines both analyses into a single action plan.

export interface CorrectionActions {
  kbEntriesToRemove: KnowledgeEntry[];
  docsToProposeFix: string[];
  hasActions: boolean;
}

export function buildCorrectionActions(
  references: string[],
  kbEntries: KnowledgeEntry[],
): CorrectionActions {
  const kbEntriesToRemove = identifyStaleKBEntries(references, kbEntries);
  const docsToProposeFix = identifyStaleDocReferences(references);

  return {
    kbEntriesToRemove,
    docsToProposeFix,
    hasActions: kbEntriesToRemove.length > 0 || docsToProposeFix.length > 0,
  };
}
