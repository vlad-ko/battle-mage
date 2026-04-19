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

export function hasNoDoubleAsterisks(text: string): RubricResult {
  // Two asterisks surrounding content — Slack renders these literally.
  if (/\*\*[^*]+\*\*/.test(text)) {
    return { pass: false, detail: "contains **double asterisks** — Slack uses single asterisks" };
  }
  return { pass: true };
}

// Detects markdown pipe-syntax tables: a header row followed by a separator
// row of dashes and pipes. Single inline pipes in prose or code are allowed.
const MARKDOWN_TABLE_REGEX = /^\s*\|.+\|\s*$\n^\s*\|[\s\-:|]+\|\s*$/m;

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
