import { describe, it, expect } from "vitest";
import { formatReferences, MAX_REFERENCES } from "./references";

describe("formatReferences", () => {
  it("returns empty string when no refs", () => {
    expect(formatReferences([])).toBe("");
  });

  it("includes a 'References' header", () => {
    const result = formatReferences([
      { label: "src/index.ts", url: "https://github.com/a/b/blob/main/src/index.ts" },
    ]);
    expect(result).toContain("*References:*");
  });

  it("formats each reference as a bullet with Slack link", () => {
    const result = formatReferences([
      { label: "src/index.ts", url: "https://github.com/a/b/blob/main/src/index.ts" },
    ]);
    expect(result).toContain("• <https://github.com/a/b/blob/main/src/index.ts|src/index.ts>");
  });

  it("deduplicates references by label (case-insensitive)", () => {
    const result = formatReferences([
      { label: "Dockerfile", url: "https://github.com/a/b/blob/main/Dockerfile" },
      { label: "Dockerfile", url: "https://github.com/a/b/blob/main/Dockerfile" },
      { label: "dockerfile", url: "https://github.com/a/b/blob/other/Dockerfile" },
    ]);
    // Should have exactly one bullet (deduped from 3 inputs)
    const bullets = result.match(/•/g);
    expect(bullets?.length).toBe(1);
  });

  it("caps at MAX_REFERENCES and shows overflow count", () => {
    const refs = Array.from({ length: 8 }, (_, i) => ({
      label: `file${i}.ts`,
      url: `https://github.com/a/b/blob/main/file${i}.ts`,
    }));
    const result = formatReferences(refs);

    // Should have exactly MAX_REFERENCES bullet items
    const bullets = result.match(/•/g);
    expect(bullets?.length).toBe(MAX_REFERENCES);

    // Should mention overflow
    expect(result).toMatch(/and \d+ more/);
  });

  it("does not show overflow when refs fit within limit", () => {
    const refs = [
      { label: "a.ts", url: "https://example.com/a.ts" },
      { label: "b.ts", url: "https://example.com/b.ts" },
    ];
    const result = formatReferences(refs);
    expect(result).not.toContain("more");
  });

  it("MAX_REFERENCES is 5", () => {
    expect(MAX_REFERENCES).toBe(5);
  });

  it("includes feedback hint after references", () => {
    const result = formatReferences([
      { label: "a.ts", url: "https://example.com/a.ts" },
    ]);
    expect(result).toContain("👍");
    expect(result).toContain("👎");
    expect(result).toMatch(/better answers/i);
  });

  it("feedback hint is italic", () => {
    const result = formatReferences([
      { label: "a.ts", url: "https://example.com/a.ts" },
    ]);
    // The hint line should be wrapped in underscores (Slack italic)
    expect(result).toMatch(/_.*👍.*👎.*_/);
  });

  it("no feedback hint when no references", () => {
    const result = formatReferences([]);
    expect(result).toBe("");
  });
});
