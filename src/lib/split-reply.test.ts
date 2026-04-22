import { describe, it, expect } from "vitest";
import {
  splitSlackReplyText,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_LINES,
  CONTINUATION_MARKER,
} from "./split-reply";

describe("splitSlackReplyText", () => {
  describe("pass-through (no split needed)", () => {
    it("returns single chunk for short text", () => {
      const text = "hello world";
      expect(splitSlackReplyText(text)).toEqual([text]);
    });

    it("returns single chunk exactly at maxChars", () => {
      const text = "a".repeat(DEFAULT_MAX_CHARS);
      const chunks = splitSlackReplyText(text);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });

    it("returns single chunk exactly at maxLines", () => {
      const lines = Array.from({ length: DEFAULT_MAX_LINES }, (_, i) => `line ${i}`);
      const text = lines.join("\n");
      const chunks = splitSlackReplyText(text);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });

    it("returns empty array for empty input", () => {
      expect(splitSlackReplyText("")).toEqual([]);
    });

    it("returns empty array for whitespace-only input", () => {
      expect(splitSlackReplyText("   \n\n  ")).toEqual([]);
    });
  });

  describe("split boundaries (priority order)", () => {
    it("prefers paragraph boundary (\\n\\n) over line boundary", () => {
      // Build text with both paragraph and line breaks; cut must land on paragraph
      const paragraph1 = "Short intro paragraph.";
      const paragraph2 = "a".repeat(120) + "\n" + "b".repeat(120);
      const paragraph3 = "Conclusion.";
      const text = `${paragraph1}\n\n${paragraph2}\n\n${paragraph3}`;

      const chunks = splitSlackReplyText(text, { maxChars: 200 });
      expect(chunks.length).toBeGreaterThan(1);
      // First chunk (stripped of continuation marker) must end at a
      // paragraph boundary — not mid-line.
      const firstContent = (chunks[0] ?? "").replace(CONTINUATION_MARKER, "").trimEnd();
      expect(firstContent.endsWith(paragraph1)).toBe(true);
    });

    it("falls back to line boundary (\\n) when no paragraph fits", () => {
      const line1 = "a".repeat(80);
      const line2 = "b".repeat(80);
      const line3 = "c".repeat(80);
      // No \n\n at all, just \n — one long paragraph split into three lines
      const text = `${line1}\n${line2}\n${line3}`;

      const chunks = splitSlackReplyText(text, { maxChars: 150 });
      expect(chunks.length).toBeGreaterThan(1);
      // First chunk (stripped of continuation marker) must end with
      // line1 content (line boundary split).
      const firstContent = (chunks[0] ?? "").replace(CONTINUATION_MARKER, "").trimEnd();
      expect(firstContent.endsWith(line1)).toBe(true);
    });

    it("falls back to word boundary when no line break fits in budget", () => {
      // One long run of words, no newlines — cut on a space
      const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
      const chunks = splitSlackReplyText(words, { maxChars: 60 });

      expect(chunks.length).toBeGreaterThan(1);
      // No chunk should end mid-word (except the final chunk by coincidence)
      for (let i = 0; i < chunks.length - 1; i++) {
        const chunk = chunks[i] ?? "";
        // Strip the continuation marker for this check
        const stripped = chunk.replace(CONTINUATION_MARKER, "").trimEnd();
        // The chunk content should end with a complete word (not a partial)
        expect(stripped).toMatch(/word\d+$/);
      }
    });

    it("hard-cuts when a single token exceeds budget", () => {
      const megaword = "a".repeat(5_000);
      const chunks = splitSlackReplyText(megaword, { maxChars: 1_000 });
      expect(chunks.length).toBeGreaterThanOrEqual(5);
      // Every chunk must be within budget
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(1_000);
      }
    });
  });

  describe("continuation marker behavior", () => {
    it("appends marker to non-final chunks when >= 3 chunks", () => {
      const text = "x".repeat(9_000);
      const chunks = splitSlackReplyText(text, { maxChars: 3_000 });
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < chunks.length - 1; i++) {
        expect(chunks[i]).toMatch(/continued|continue|↓/i);
      }
      // Final chunk must NOT carry the marker
      expect(chunks.at(-1)).not.toMatch(/continued|↓/i);
    });

    it("drops the continuation marker on the 2-chunk case (cleaner UX)", () => {
      // Just over maxChars → exactly 2 chunks → marker dropped
      const text = "a".repeat(3_500);
      const chunks = splitSlackReplyText(text, { maxChars: 3_000 });
      expect(chunks).toHaveLength(2);
      // Neither chunk should contain the marker text
      for (const chunk of chunks) {
        expect(chunk).not.toMatch(/\[continued/i);
      }
    });

    it("every chunk fits within maxChars INCLUDING the marker", () => {
      const text = "x".repeat(9_000);
      const chunks = splitSlackReplyText(text, { maxChars: 3_000 });
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(3_000);
      }
    });
  });

  describe("code fence continuation", () => {
    it("closes and reopens an unmatched fence across a split", () => {
      // Build a long code block that MUST split
      const codeBody = Array.from({ length: 80 }, (_, i) => `  line ${i}: ${"x".repeat(30)}`).join("\n");
      const text = `Here's the code:\n\n\`\`\`typescript\n${codeBody}\n\`\`\`\n\nThat's all.`;

      const chunks = splitSlackReplyText(text, { maxChars: 800 });
      expect(chunks.length).toBeGreaterThan(1);

      // Count fences per chunk — each chunk must have balanced fences
      for (const chunk of chunks) {
        const fenceCount = (chunk.match(/```/g) ?? []).length;
        expect(fenceCount % 2).toBe(0);
      }
    });

    it("preserves the language tag when reopening a fence", () => {
      const codeBody = "x".repeat(2_000);
      const text = `\`\`\`python\n${codeBody}\n\`\`\``;

      const chunks = splitSlackReplyText(text, { maxChars: 800 });
      expect(chunks.length).toBeGreaterThan(1);
      // Chunk 2+ should re-open with ```python
      // (not just ```)
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i]).toMatch(/^```python/);
      }
    });

    it("tilde fences (~~~) are treated the same as backticks", () => {
      const codeBody = "y".repeat(2_000);
      const text = `~~~\n${codeBody}\n~~~`;
      const chunks = splitSlackReplyText(text, { maxChars: 800 });
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        const tildeCount = (chunk.match(/~~~/g) ?? []).length;
        expect(tildeCount % 2).toBe(0);
      }
    });
  });

  describe("line budget", () => {
    it("splits on line count even when char budget has room", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `short line ${i}`);
      const text = lines.join("\n");
      // Plenty of chars available, but line budget should force split
      const chunks = splitSlackReplyText(text, { maxChars: 10_000, maxLines: 30 });
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        const lineCount = chunk.split("\n").length;
        expect(lineCount).toBeLessThanOrEqual(30);
      }
    });
  });

  describe("unicode and real-world content", () => {
    it("handles em-dash heavy content (no byte/char confusion)", () => {
      // This was the #111 regression — em-dashes are 3 bytes but 1 char.
      // Splitter works in CHARS, matching Slack's reported limit.
      const text = "—".repeat(10_000);
      const chunks = splitSlackReplyText(text, { maxChars: 3_000 });
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(3_000);
      }
    });

    it("handles emoji content (surrogate pairs not mid-split)", () => {
      const text = "🧠".repeat(4_000);
      const chunks = splitSlackReplyText(text, { maxChars: 3_000 });
      expect(chunks.length).toBeGreaterThan(1);
      // No chunk should contain a lone high surrogate (broken emoji)
      for (const chunk of chunks) {
        // A lone high surrogate is D800-DBFF without a following low surrogate.
        // This regex matches one if present — test asserts none are.
        expect(chunk).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
        expect(chunk).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      }
    });
  });

  describe("invariants (mutation testing)", () => {
    it("concatenating non-marker content yields the original (lossless for long runs)", () => {
      // Splitter may strip continuation markers and trailing whitespace, but
      // the original SEMANTIC content must be preserved.
      const original = "a".repeat(500) + "\n\n" + "b".repeat(500) + "\n\n" + "c".repeat(500);
      const chunks = splitSlackReplyText(original, { maxChars: 600 });

      // Strip the continuation marker from each chunk and rejoin
      const stripped = chunks
        .map((c) => c.replace(CONTINUATION_MARKER, "").trimEnd())
        .join("\n\n");

      // Key characters should all be present
      expect(stripped).toContain("a".repeat(500));
      expect(stripped).toContain("b".repeat(500));
      expect(stripped).toContain("c".repeat(500));
    });

    it("never returns an empty string chunk", () => {
      const text = "x\n\n\n\n" + "y".repeat(5_000) + "\n\n\n\n" + "z";
      const chunks = splitSlackReplyText(text, { maxChars: 1_000 });
      for (const chunk of chunks) {
        expect(chunk.trim().length).toBeGreaterThan(0);
      }
    });

    it("returns at least one chunk for non-empty input", () => {
      const text = "x";
      const chunks = splitSlackReplyText(text);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("DEFAULT_MAX_CHARS stays well under Slack's 40,000 limit", () => {
      expect(DEFAULT_MAX_CHARS).toBeLessThan(10_000);
      expect(DEFAULT_MAX_CHARS).toBeGreaterThan(1_000);
    });
  });
});
