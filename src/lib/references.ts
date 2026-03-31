import type { Reference } from "@/tools";

/**
 * Reference ranking and formatting.
 *
 * References are ranked to mirror the source-of-truth hierarchy:
 *   code > tests > cited refs > docs > uncited list results
 */
export const MAX_REFERENCES = 7;

const TYPE_EMOJI: Record<string, string> = {
  issue: "🎫",
  pr: "🔀",
  commit: "📜",
  file: "📄",
  doc: "📖",
};

// ── Test path detection ──────────────────────────────────────────────
const TEST_PATTERNS = /\btests?\b|\.test\.|\.spec\.|__tests__/i;

function isTestFile(label: string): boolean {
  return TEST_PATTERNS.test(label);
}

// ── Score a reference by source-of-truth hierarchy ───────────────────
function scoreRef(ref: Reference, answerText: string): number {
  let score = 0;

  // Tier 1: Source code files (non-doc, non-test) — highest trust
  if (ref.type === "file" && !isTestFile(ref.label)) {
    score += 50;
  }

  // Tier 2: Test files
  if (ref.type === "file" && isTestFile(ref.label)) {
    score += 40;
  }

  // Citation boost: ref mentioned in the answer text
  // Check for label fragments: #number, file paths, SHA prefixes
  const labelParts = ref.label.split(/\s+/);
  for (const part of labelParts) {
    if (part.length > 2 && answerText.includes(part)) {
      score += 20;
      break;
    }
  }

  // Tier 4: Documentation
  if (ref.type === "doc") {
    score += 10;
  }

  // Tier 5: Uncited issues/PRs/commits get base score of 0

  return score;
}

// ── Rank references by relevance ─────────────────────────────────────
export function rankReferences(
  refs: Reference[],
  answerText: string,
): Reference[] {
  if (refs.length === 0) return [];

  // Score each ref, then stable-sort descending
  const scored = refs.map((ref, index) => ({
    ref,
    score: scoreRef(ref, answerText),
    originalIndex: index,
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex; // stable within same score
  });

  return scored.map((s) => s.ref);
}

// ── Format references as Slack footer ────────────────────────────────
export function formatReferences(refs: Reference[]): string {
  if (refs.length === 0) return "";

  // Deduplicate by label (case-insensitive, keep first occurrence)
  const seen = new Set<string>();
  const unique = refs.filter((r) => {
    const key = r.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Cap at MAX_REFERENCES
  const capped = unique.slice(0, MAX_REFERENCES);
  const overflow = unique.length - capped.length;

  const lines = capped.map((r) => {
    const emoji = TYPE_EMOJI[r.type] || "🔗";
    return `  • ${emoji} <${r.url}|${r.label}>`;
  });
  if (overflow > 0) {
    lines.push(`  _...and ${overflow} more_`);
  }

  const hint = "\n_React with 👍 or 👎 to help me give better answers in the future._";
  return `\n\n───\n*References:*\n${lines.join("\n")}${hint}`;
}
