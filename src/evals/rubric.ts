import type { Reference } from "@/tools";

export interface RubricResult {
  pass: boolean;
  detail?: string;
}

// Mirrors the output contract in src/lib/claude.ts. Keep in sync if you
// add/remove banned phrases in the prompt — otherwise evals will either
// under-detect or false-positive.
export const BANNED_NARRATION_PHRASES = [
  "let me check",
  "let me look",
  "i'll look",
  "i'll check",
  "one moment",
  "fetching now",
  "hold on while i",
  "looking into that",
  "looking into this",
] as const;

function lower(s: string): string {
  return s.toLowerCase();
}

export function hasNoNarration(text: string): RubricResult {
  const haystack = lower(text);
  for (const phrase of BANNED_NARRATION_PHRASES) {
    if (haystack.includes(phrase)) {
      return { pass: false, detail: `contains banned narration phrase: "${phrase}"` };
    }
  }
  return { pass: true };
}

// Matches [anything](anything) but avoids single-element bracket references
// like [1] or [RFC 7591] by requiring at least one '(' with a URL-ish payload.
const MARKDOWN_LINK_REGEX = /\[[^\]]+\]\([^)]+\)/;

export function hasNoMarkdownLinks(text: string): RubricResult {
  const match = text.match(MARKDOWN_LINK_REGEX);
  if (match) {
    return {
      pass: false,
      detail: `contains markdown-style link "${match[0]}" — use <url|label> for Slack`,
    };
  }
  return { pass: true };
}

// Non-greedy match — catches **a*b** and ***x*** where the old [^*]+ missed
// any span containing a stray asterisk (e.g. literal code `**foo*bar**`).
const DOUBLE_ASTERISK_REGEX = /\*\*[\s\S]+?\*\*/;

export function hasNoDoubleAsterisks(text: string): RubricResult {
  if (DOUBLE_ASTERISK_REGEX.test(text)) {
    return { pass: false, detail: "contains **double asterisks** — Slack uses single asterisks" };
  }
  return { pass: true };
}

// Detects markdown pipe-tables with OR without outer pipes. A table is
// identified by a header line containing at least one `|`, immediately
// followed by a separator line matching `---|---` (optionally with outer
// pipes and alignment colons). Single inline pipes in prose/code are safe.
const MARKDOWN_TABLE_REGEX =
  /^[^\n]*\|[^\n]*\n^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m;

export function hasNoMarkdownTables(text: string): RubricResult {
  if (MARKDOWN_TABLE_REGEX.test(text)) {
    return {
      pass: false,
      detail: "contains a markdown pipe-table — Slack renders them broken; use bullets",
    };
  }
  return { pass: true };
}

export function isWithinCharLimit(text: string, maxChars: number): RubricResult {
  if (text.length > maxChars) {
    return {
      pass: false,
      detail: `answer is ${text.length} chars, exceeds limit of ${maxChars}`,
    };
  }
  return { pass: true };
}

export function referenceLabelsInclude(
  refs: Reference[],
  expectedSubstring: string,
): RubricResult {
  const match = refs.find((r) => r.label.includes(expectedSubstring));
  if (!match) {
    const labels = refs.map((r) => r.label).join(", ") || "(none)";
    return {
      pass: false,
      detail: `no reference matched "${expectedSubstring}"; got: ${labels}`,
    };
  }
  return { pass: true };
}
