// ── Slack reply splitter ──────────────────────────────────────────────
// Long answers are split into multiple thread replies rather than
// truncated at a character cap. Truncation silently eats content
// (including the user's call-to-action in issue-proposal messages)
// and still trips Slack's msg_too_long because the "40K limit" is not
// the only constraint in play. Splitting removes the limit entirely
// from the happy path.
//
// Priority order when picking a cut point: paragraph (\n\n) > line (\n)
// > word (space) > hard-cut. Code fences are tracked and re-opened on
// the next chunk so ``` blocks stay valid.
//
// Pure function, no I/O. Colocated tests in split-reply.test.ts.

export const DEFAULT_MAX_CHARS = 3_000;
export const DEFAULT_MAX_LINES = 60;
export const CONTINUATION_MARKER = "\n\n_[continued ↓]_";

export interface SplitOptions {
  maxChars?: number;
  maxLines?: number;
}

interface FenceState {
  // Language tag (e.g. "python", "typescript") or "" for fence with no tag.
  // undefined means no fence currently open.
  openLang: string | undefined;
  // The fence marker (``` or ~~~) currently open.
  openMarker: "```" | "~~~" | undefined;
}

const FENCE_RE = /^(```|~~~)([\w+-]*)\s*$/;

// Walk every line; toggle fence state on opening/closing markers.
// Returns the fence state at the END of the given text.
function trackFenceState(text: string, initial: FenceState): FenceState {
  let state = { ...initial };
  for (const line of text.split("\n")) {
    const match = FENCE_RE.exec(line);
    if (!match) continue;
    const marker = match[1] as "```" | "~~~";
    const lang = match[2] ?? "";
    if (state.openMarker === undefined) {
      state = { openMarker: marker, openLang: lang };
    } else if (state.openMarker === marker) {
      state = { openMarker: undefined, openLang: undefined };
    }
    // Mismatched close (e.g. ~~~ inside a ``` block) — ignore as text.
  }
  return state;
}

// Find the best cut point in `text` at or before `limit` characters.
// Returns the index AT which to cut (exclusive): text.slice(0, cut) is
// the chunk; text.slice(cut) is the remainder. Whitespace at the boundary
// is consumed into the cut point.
function findCutIndex(text: string, limit: number): number {
  if (text.length <= limit) return text.length;

  // 1. Paragraph boundary
  const paragraphCut = text.lastIndexOf("\n\n", limit);
  if (paragraphCut > 0) return paragraphCut;

  // 2. Line boundary
  const lineCut = text.lastIndexOf("\n", limit);
  if (lineCut > 0) return lineCut;

  // 3. Word boundary (space)
  const spaceCut = text.lastIndexOf(" ", limit);
  if (spaceCut > 0) return spaceCut;

  // 4. Hard cut — but be careful about surrogate pairs. If `limit` lands
  // on the low half of a surrogate pair, back up one so the emoji stays
  // whole on the earlier chunk.
  const codeUnit = text.charCodeAt(limit - 1);
  if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
    return limit - 1;
  }
  return limit;
}

// Enforce the line budget BEFORE the char budget: if `text` has more
// than `maxLines` lines, truncate to that many lines first, then let
// the char-budget cut further if needed.
function applyLineBudget(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n");
}

export function splitSlackReplyText(
  text: string,
  options?: SplitOptions,
): string[] {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;

  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  // Fast path: whole message fits both budgets.
  const fitsChars = trimmed.length <= maxChars;
  const fitsLines = trimmed.split("\n").length <= maxLines;
  if (fitsChars && fitsLines) return [trimmed];

  // Reserve room for the continuation marker on intermediate chunks so
  // appending it can't push the chunk back over budget — both in chars
  // and in lines. The marker is `\n\n_[continued ↓]_` → 2 extra newlines.
  const markerLen = CONTINUATION_MARKER.length;
  const markerLines = (CONTINUATION_MARKER.match(/\n/g) ?? []).length;
  const chunkBudget = Math.max(1, maxChars - markerLen);
  // Also reserve 1 line for a potential fence-close ("```") on a split
  // that lands inside a code block.
  const intermediateLineBudget = Math.max(1, maxLines - markerLines - 1);

  const chunks: string[] = [];
  let remaining = trimmed;
  let fenceState: FenceState = { openMarker: undefined, openLang: undefined };

  // Safety bound: we'll never produce more than `text.length` chunks,
  // and each iteration strictly shrinks `remaining`.
  const maxIterations = Math.max(10, Math.ceil(trimmed.length / Math.max(1, chunkBudget)) + 4);
  let iter = 0;

  while (remaining.length > 0) {
    if (iter++ > maxIterations) {
      // Hard backstop — should be unreachable given the cut-advances-invariant.
      chunks.push(remaining);
      break;
    }

    // Does the remainder fit as the final chunk (no marker needed)?
    const finalFitsChars = remaining.length <= maxChars;
    const finalFitsLines = remaining.split("\n").length <= maxLines;
    if (finalFitsChars && finalFitsLines) {
      // Re-open any inherited fence so the final chunk is self-contained.
      const prefixed = fenceState.openMarker !== undefined
        ? `${fenceState.openMarker}${fenceState.openLang}\n${remaining}`
        : remaining;
      chunks.push(prefixed);
      break;
    }

    // Apply line budget first (cheaper), then char budget.
    // Use the intermediate line budget since this chunk will get a marker
    // (and possibly a fence-close) appended.
    const lineBudgeted = applyLineBudget(remaining, intermediateLineBudget);
    const cut = findCutIndex(lineBudgeted, chunkBudget);
    if (cut <= 0) {
      // Degenerate — force progress with a hard cut at the chunk budget.
      const forced = Math.min(chunkBudget, remaining.length);
      const rawChunk = remaining.slice(0, forced);
      remaining = remaining.slice(forced).replace(/^\s+/, "");
      const finalized = finalizeChunk(rawChunk, fenceState, /*hasMore=*/ remaining.length > 0);
      chunks.push(finalized.text);
      fenceState = finalized.fenceState;
      continue;
    }

    const rawChunk = remaining.slice(0, cut);
    remaining = remaining.slice(cut).replace(/^\s+/, "");
    const finalized = finalizeChunk(rawChunk, fenceState, /*hasMore=*/ remaining.length > 0);
    chunks.push(finalized.text);
    fenceState = finalized.fenceState;
  }

  // Visual-polish: drop the continuation marker in the exact 2-chunk case.
  if (chunks.length === 2) {
    chunks[0] = (chunks[0] ?? "").replace(CONTINUATION_MARKER, "").trimEnd();
  }

  return chunks.filter((c) => c.trim().length > 0);
}

// Given a raw chunk + the fence state coming IN, produce:
// - the finalized chunk text (prefixed with fence re-open if needed,
//   suffixed with fence close + continuation marker if needed)
// - the fence state to carry into the NEXT chunk
function finalizeChunk(
  rawChunk: string,
  incomingFence: FenceState,
  hasMore: boolean,
): { text: string; fenceState: FenceState } {
  // Prefix with fence re-open if we're inheriting one from a prior chunk.
  let text = incomingFence.openMarker !== undefined
    ? `${incomingFence.openMarker}${incomingFence.openLang}\n${rawChunk}`
    : rawChunk;

  // Track fence state ACROSS the prefixed text (the re-opened fence might
  // close within this chunk, in which case we don't need to carry state).
  const outgoing = trackFenceState(text, { openMarker: undefined, openLang: undefined });

  // If a fence is still open at end-of-chunk AND there's more content to
  // come, close the fence here and the next chunk will re-open it.
  if (outgoing.openMarker !== undefined && hasMore) {
    text = `${text.trimEnd()}\n${outgoing.openMarker}`;
  }

  // Continuation marker on non-final chunks.
  if (hasMore) {
    text = text + CONTINUATION_MARKER;
  }

  // Carry the fence state forward only if this chunk ends with an open fence
  // and there's more content.
  const carry: FenceState = hasMore && outgoing.openMarker !== undefined
    ? outgoing
    : { openMarker: undefined, openLang: undefined };

  return { text, fenceState: carry };
}
