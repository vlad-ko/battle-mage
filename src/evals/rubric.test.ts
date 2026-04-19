import { describe, it, expect } from "vitest";
import {
  hasNoNarration,
  hasNoMarkdownLinks,
  hasNoDoubleAsterisks,
  hasNoMarkdownTables,
  isWithinCharLimit,
  referenceLabelsInclude,
  BANNED_NARRATION_PHRASES,
} from "./rubric";

describe("rubric scorers — pure, deterministic output-contract checks", () => {
  describe("hasNoNarration", () => {
    it("passes on a clean result-focused answer", () => {
      const r = hasNoNarration("Signature verification lives in `src/lib/slack.ts`.");
      expect(r.pass).toBe(true);
    });

    it("fails and names the phrase when narration appears", () => {
      const r = hasNoNarration("Let me check that for you. The answer is...");
      expect(r.pass).toBe(false);
      expect(r.detail?.toLowerCase()).toContain("let me check");
    });

    it("detects each banned phrase case-insensitively", () => {
      for (const phrase of BANNED_NARRATION_PHRASES) {
        const r = hasNoNarration(`Prefix ${phrase.toUpperCase()} suffix`);
        expect(r.pass, `failed to detect "${phrase}"`).toBe(false);
      }
    });

    it("does not false-positive on substrings that happen to share words", () => {
      // "I'll look" is banned; "I look forward to" should not trigger (no "i'll")
      const r = hasNoNarration("I look at the code and it seems correct.");
      expect(r.pass).toBe(true);
    });
  });

  describe("hasNoMarkdownLinks", () => {
    it("passes on Slack-style links", () => {
      const r = hasNoMarkdownLinks("See <https://github.com|the repo> for details.");
      expect(r.pass).toBe(true);
    });

    it("fails on [label](url) markdown links", () => {
      const r = hasNoMarkdownLinks("See [the repo](https://github.com) for details.");
      expect(r.pass).toBe(false);
      expect(r.detail).toContain("[the repo](https://github.com)");
    });

    it("fails on bracket-syntax inside a longer paragraph", () => {
      const r = hasNoMarkdownLinks(
        "The route handler lives here: [route.ts](src/app/api/slack/route.ts). It does X.",
      );
      expect(r.pass).toBe(false);
    });

    it("does not false-positive on plain bracketed lists like [1], [2]", () => {
      const r = hasNoMarkdownLinks("Steps: [1] do this, [2] do that.");
      expect(r.pass).toBe(true);
    });
  });

  describe("hasNoDoubleAsterisks", () => {
    it("passes on Slack single-asterisk bold", () => {
      const r = hasNoDoubleAsterisks("The *important* bit.");
      expect(r.pass).toBe(true);
    });

    it("fails on **markdown bold**", () => {
      const r = hasNoDoubleAsterisks("The **important** bit.");
      expect(r.pass).toBe(false);
    });
  });

  describe("hasNoMarkdownTables", () => {
    it("passes on bullet lists", () => {
      const r = hasNoMarkdownTables("Options:\n- one\n- two\n- three");
      expect(r.pass).toBe(true);
    });

    it("fails on pipe-syntax tables", () => {
      const r = hasNoMarkdownTables(
        "| Column A | Column B |\n| --- | --- |\n| 1 | 2 |",
      );
      expect(r.pass).toBe(false);
    });

    it("does not false-positive on a single pipe in prose", () => {
      const r = hasNoMarkdownTables("Use pipes like `ls | grep` for stdout.");
      expect(r.pass).toBe(true);
    });
  });

  describe("isWithinCharLimit", () => {
    it("passes when the text is shorter than the limit", () => {
      const r = isWithinCharLimit("short", 100);
      expect(r.pass).toBe(true);
    });

    it("fails and reports length when the text exceeds the limit", () => {
      const r = isWithinCharLimit("a".repeat(500), 100);
      expect(r.pass).toBe(false);
      expect(r.detail).toContain("500");
      expect(r.detail).toContain("100");
    });

    it("treats the limit as inclusive", () => {
      const r = isWithinCharLimit("a".repeat(100), 100);
      expect(r.pass).toBe(true);
    });
  });

  describe("referenceLabelsInclude", () => {
    it("passes when the expected substring appears in at least one reference label", () => {
      const refs = [
        { label: "src/lib/slack.ts", url: "u1", type: "file" as const },
        { label: "src/lib/claude.ts", url: "u2", type: "file" as const },
      ];
      const r = referenceLabelsInclude(refs, "slack.ts");
      expect(r.pass).toBe(true);
    });

    it("fails when no reference label matches the expected substring", () => {
      const refs = [{ label: "src/lib/foo.ts", url: "u", type: "file" as const }];
      const r = referenceLabelsInclude(refs, "bar.ts");
      expect(r.pass).toBe(false);
      expect(r.detail).toContain("bar.ts");
    });

    it("fails when the reference list is empty", () => {
      const r = referenceLabelsInclude([], "anything");
      expect(r.pass).toBe(false);
    });
  });
});
