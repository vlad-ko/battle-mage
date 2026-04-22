import { describe, it, expect } from "vitest";
import {
  deriveReferenceTypes,
  formatFeedbackSummary,
  type FeedbackEntry,
  type QAContext,
} from "./feedback";
import type { Reference } from "@/tools";

describe("deriveReferenceTypes", () => {
  it("returns empty array for empty input", () => {
    expect(deriveReferenceTypes([])).toEqual([]);
  });

  it("returns unique types sorted alphabetically", () => {
    const refs: Reference[] = [
      { label: "src/a.ts", url: "u1", type: "file" },
      { label: "docs/b.md", url: "u2", type: "doc" },
      { label: "src/c.ts", url: "u3", type: "file" },
      { label: "#42", url: "u4", type: "issue" },
    ];
    expect(deriveReferenceTypes(refs)).toEqual(["doc", "file", "issue"]);
  });

  it("dedupes across identical types", () => {
    const refs: Reference[] = [
      { label: "#1", url: "u1", type: "issue" },
      { label: "#2", url: "u2", type: "issue" },
      { label: "#3", url: "u3", type: "issue" },
    ];
    expect(deriveReferenceTypes(refs)).toEqual(["issue"]);
  });

  it("handles all five type values", () => {
    const refs: Reference[] = [
      { label: "a", url: "u", type: "file" },
      { label: "b", url: "u", type: "doc" },
      { label: "c", url: "u", type: "issue" },
      { label: "d", url: "u", type: "pr" },
      { label: "e", url: "u", type: "commit" },
    ];
    expect(deriveReferenceTypes(refs)).toEqual(["commit", "doc", "file", "issue", "pr"]);
  });
});

describe("formatFeedbackSummary", () => {
  const mkEntry = (type: "positive" | "negative", i: number): FeedbackEntry => ({
    type,
    question: `question ${i}`,
    detail: `detail ${i}`,
    timestamp: "2026-04-22",
  });

  it("returns null when no entries", () => {
    expect(formatFeedbackSummary([])).toBeNull();
  });

  it("counts positive and negative entries separately", () => {
    const entries: FeedbackEntry[] = [
      mkEntry("positive", 1),
      mkEntry("positive", 2),
      mkEntry("negative", 3),
    ];
    const summary = formatFeedbackSummary(entries);
    expect(summary).not.toBeNull();
    expect(summary!.positiveCount).toBe(2);
    expect(summary!.negativeCount).toBe(1);
    expect(summary!.totalEntries).toBe(3);
  });

  it("renders the positive section only when positives exist", () => {
    const entries = [mkEntry("positive", 1)];
    const summary = formatFeedbackSummary(entries)!;
    expect(summary.markdown).toMatch(/What worked well/i);
    expect(summary.markdown).not.toMatch(/needed correction/i);
  });

  it("renders the negative section only when negatives exist", () => {
    const entries = [mkEntry("negative", 1)];
    const summary = formatFeedbackSummary(entries)!;
    expect(summary.markdown).toMatch(/needed correction/i);
    expect(summary.markdown).not.toMatch(/What worked well/i);
  });

  it("caps at 30 entries but counts are post-cap", () => {
    // Pass 40 entries; only first 30 get rendered. Counts reflect what
    // WENT INTO the prompt, not raw storage.
    const entries = Array.from({ length: 40 }, (_, i) =>
      mkEntry(i % 2 === 0 ? "positive" : "negative", i),
    );
    const summary = formatFeedbackSummary(entries)!;
    // 30 entries rendered, with index 0..29 → 15 positive (even) + 15 negative (odd)
    expect(summary.totalEntries).toBe(30);
    expect(summary.positiveCount).toBe(15);
    expect(summary.negativeCount).toBe(15);
  });

  it("preserves insertion order within each section", () => {
    const entries = [mkEntry("positive", 1), mkEntry("positive", 2)];
    const summary = formatFeedbackSummary(entries)!;
    const idx1 = summary.markdown.indexOf("question 1");
    const idx2 = summary.markdown.indexOf("question 2");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
  });
});

describe("QAContext schema", () => {
  // The type is the contract — this test pins all fields so a future
  // refactor removing one breaks here first.
  it("has all required observability fields", () => {
    const ctx: QAContext = {
      question: "q",
      answer: "a",
      references: ["f1"],
      answerTs: "1234.5678",
      chunkIndex: 0,
      chunkCount: 1,
      postedAt: 1234567890,
      referenceTypes: ["file"],
    };
    expect(ctx.answerTs).toBe("1234.5678");
    expect(ctx.chunkIndex).toBe(0);
    expect(ctx.chunkCount).toBe(1);
    expect(ctx.postedAt).toBe(1234567890);
    expect(ctx.referenceTypes).toEqual(["file"]);
  });
});
