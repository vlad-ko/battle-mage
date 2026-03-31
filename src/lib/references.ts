import type { Reference } from "@/tools";

/**
 * Format references as a clean Slack footer.
 * Deduplicates, caps at a reasonable limit, and adds a clear header.
 */
export const MAX_REFERENCES = 5;

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

  // Cap at MAX_REFERENCES to keep it scannable
  const capped = unique.slice(0, MAX_REFERENCES);
  const overflow = unique.length - capped.length;

  const lines = capped.map((r) => `  • <${r.url}|${r.label}>`);
  if (overflow > 0) {
    lines.push(`  _...and ${overflow} more_`);
  }

  const hint = "\n_React with 👍 or 👎 to help me give better answers in the future._";
  return `\n\n───\n*References:*\n${lines.join("\n")}${hint}`;
}
