import type { Reference } from "@/tools";

/**
 * Format references as a clean Slack footer with type labels.
 * Deduplicates, caps at MAX_REFERENCES, and adds feedback hint.
 */
export const MAX_REFERENCES = 10;

const TYPE_EMOJI: Record<string, string> = {
  issue: "🎫",
  pr: "🔀",
  commit: "📜",
  file: "📄",
  doc: "📖",
};

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
