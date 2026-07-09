/**
 * Code chunking for the incremental semantic code index (#135).
 *
 * Two pure exports:
 * - isEmbeddableSourcePath — the SINGLE eligibility predicate (invariant
 *   S6). Both sides of the tree/manifest diff in code-index.ts consume
 *   this exact function, so a file can never be simultaneously "should
 *   upsert" and "should delete".
 * - chunkCodeFile — splits one file into embeddable chunks. TS/JS files
 *   split at column-0 declaration boundaries (a cheap, dependency-free
 *   proxy for top-level structure); everything else uses a greedy
 *   line-window pack. Every chunk's text is prefixed with the file path
 *   so the embedding carries location context, and is HARD-capped at
 *   MAX_CODE_CHUNK_CHARS unconditionally.
 *
 * Everything here is pure — the GitHub/vector side effects live in
 * code-index.ts.
 */

import { isToolingPath } from "./path-filter";
import { getAnnotation, type BattleMageConfig } from "./config";

/** Hard character cap per embedded chunk (path header included). */
export const MAX_CODE_CHUNK_CHARS = 1500;

/** Files larger than this are never fetched or embedded — generated
 * bundles and fixtures dominate above this size, not source. */
export const MAX_EMBED_FILE_BYTES = 200_000;

// Extension allowlist: source code only. Deliberately excludes prose
// (md — the docs arm owns it), data/config noise (json/yaml/lock), and
// anything else that would pollute semantic code recall.
const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "php", "go", "rs",
  "java", "kt", "kts", "swift", "scala",
  "c", "h", "cc", "cpp", "hpp", "cs",
  "sh", "bash", "sql", "vue", "svelte",
]);

// Extensions that get the column-0 declaration-boundary treatment.
const SECTION_AWARE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);

// Column-0 heuristic: a line STARTING with a top-level declaration
// keyword begins a new logical section. Indented declarations are
// nested and therefore never boundaries.
const DECLARATION_BOUNDARY_RE =
  /^(?:export\b|import\b|function\b|async\b|class\b|const\b|let\b|var\b|interface\b|type\b|enum\b|abstract\b|declare\b|namespace\b)/;

function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * The single eligibility predicate (invariant S6): is this blob a
 * source file the code index should embed?
 *
 * - extension must be on the source allowlist (no md/json/yaml/lock)
 * - tooling paths (.claude/ etc.) are never source
 * - minified artifacts (`.min.`) are generated, not source
 * - config annotations excluded/vendor/historic opt the path out
 * - blobs over MAX_EMBED_FILE_BYTES are skipped; an UNKNOWN size stays
 *   eligible (the tree API omits size for some entries)
 */
export function isEmbeddableSourcePath(
  path: string,
  size: number | undefined,
  config: BattleMageConfig,
): boolean {
  if (size !== undefined && size > MAX_EMBED_FILE_BYTES) return false;
  if (isToolingPath(path)) return false;
  if (path.includes(".min.")) return false;
  if (!SOURCE_EXTENSIONS.has(extensionOf(path))) return false;
  const annotation = getAnnotation(path, config);
  return annotation !== "excluded" && annotation !== "vendor" && annotation !== "historic";
}

export interface CodeChunk {
  /** Deterministic, path-stable id: `${path}#${ordinal}`. */
  id: string;
  /** Text sent for embedding: `${path}\n\n${lines}` — capped at
   * MAX_CODE_CHUNK_CHARS including the path header. */
  text: string;
  metadata: {
    path: string;
    /** 1-based inclusive line range of the chunk's content. */
    startLine: number;
    endLine: number;
    /** Whitespace-collapsed preview, ≤160 chars — safe to render. */
    excerpt: string;
  };
}

const EXCERPT_MAX_CHARS = 160;

function makeExcerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX_CHARS);
}

interface NumberedLine {
  text: string;
  /** 1-based line number in the original file. */
  num: number;
}

interface Window {
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * Greedily pack whole lines into windows of at most `budget` chars
 * (lines joined by "\n"). A single line over budget is hard-sliced —
 * pathological (minified/generated content), but the cap must hold
 * unconditionally. Slices of one line share that line's number.
 */
function packLines(lines: NumberedLine[], budget: number): Window[] {
  const windows: Window[] = [];
  let cur: NumberedLine[] = [];
  let curLen = 0;
  const flush = () => {
    if (cur.length > 0) {
      windows.push({
        text: cur.map((l) => l.text).join("\n"),
        startLine: cur[0].num,
        endLine: cur[cur.length - 1].num,
      });
      cur = [];
      curLen = 0;
    }
  };
  for (const line of lines) {
    if (line.text.length > budget) {
      flush();
      for (let i = 0; i < line.text.length; i += budget) {
        windows.push({
          text: line.text.slice(i, i + budget),
          startLine: line.num,
          endLine: line.num,
        });
      }
      continue;
    }
    const candidate = cur.length === 0 ? line.text.length : curLen + 1 + line.text.length;
    if (candidate > budget) flush();
    curLen = cur.length === 0 ? line.text.length : curLen + 1 + line.text.length;
    cur.push(line);
  }
  flush();
  return windows;
}

/**
 * Pack declaration-delimited segments greedily; a segment that alone
 * exceeds the budget degrades to the line-window pack for its lines.
 */
function packSegments(segments: NumberedLine[][], budget: number): Window[] {
  const windows: Window[] = [];
  let cur: NumberedLine[] = [];
  let curLen = 0;
  const flush = () => {
    if (cur.length > 0) {
      windows.push({
        text: cur.map((l) => l.text).join("\n"),
        startLine: cur[0].num,
        endLine: cur[cur.length - 1].num,
      });
      cur = [];
      curLen = 0;
    }
  };
  for (const segment of segments) {
    const segLen =
      segment.reduce((sum, l) => sum + l.text.length, 0) + (segment.length - 1);
    if (segLen > budget) {
      flush();
      windows.push(...packLines(segment, budget));
      continue;
    }
    const candidate = cur.length === 0 ? segLen : curLen + 1 + segLen;
    if (candidate > budget) flush();
    curLen = cur.length === 0 ? segLen : curLen + 1 + segLen;
    cur.push(...segment);
  }
  flush();
  return windows;
}

/**
 * Split one source file into embeddable chunks. Pure function.
 *
 * TS/JS: lines are grouped into segments starting at each column-0
 * declaration boundary, then segments pack greedily up to the budget —
 * so a split always lands ON a boundary line unless a single section is
 * itself over budget. Other languages: greedy line-window pack.
 *
 * The per-chunk content budget is MAX_CODE_CHUNK_CHARS minus the
 * `${path}\n\n` header, so the FULL text never exceeds the cap.
 */
export function chunkCodeFile(path: string, content: string): CodeChunk[] {
  if (!content || content.trim().length === 0) return [];

  const rawLines = content.split("\n");
  // A trailing newline produces one empty trailing element — drop it so
  // line ranges reflect real lines.
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const lines: NumberedLine[] = rawLines.map((text, i) => ({ text, num: i + 1 }));

  const budget = Math.max(1, MAX_CODE_CHUNK_CHARS - path.length - 2);

  let windows: Window[];
  if (SECTION_AWARE_EXTENSIONS.has(extensionOf(path))) {
    const segments: NumberedLine[][] = [];
    for (const line of lines) {
      if (segments.length === 0 || DECLARATION_BOUNDARY_RE.test(line.text)) {
        segments.push([line]);
      } else {
        segments[segments.length - 1].push(line);
      }
    }
    windows = packSegments(segments, budget);
  } else {
    windows = packLines(lines, budget);
  }

  return windows.map((w, ordinal) => ({
    id: `${path}#${ordinal}`,
    text: `${path}\n\n${w.text}`,
    metadata: {
      path,
      startLine: w.startLine,
      endLine: w.endLine,
      excerpt: makeExcerpt(w.text),
    },
  }));
}
