import { describe, it, expect } from "vitest";
import { formatReferences, MAX_REFERENCES } from "./references";

describe("formatReferences", () => {
  it("returns empty string when no refs", () => {
    expect(formatReferences([])).toBe("");
  });

  it("includes a 'References' header", () => {
    const result = formatReferences([
      { label: "src/index.ts", url: "https://github.com/a/b/blob/main/src/index.ts", type: "file" },
    ]);
    expect(result).toContain("*References:*");
  });

  it("shows type emoji prefix for issues", () => {
    const result = formatReferences([
      { label: "#42 Fix login bug", url: "https://github.com/a/b/issues/42", type: "issue" },
    ]);
    expect(result).toContain("🎫");
    expect(result).toContain("#42 Fix login bug");
  });

  it("shows type emoji prefix for PRs", () => {
    const result = formatReferences([
      { label: "#100 Add auth middleware", url: "https://github.com/a/b/pull/100", type: "pr" },
    ]);
    expect(result).toContain("🔀");
  });

  it("shows type emoji prefix for commits", () => {
    const result = formatReferences([
      { label: "abc1234 fix: resolve timeout", url: "https://github.com/a/b/commit/abc1234", type: "commit" },
    ]);
    expect(result).toContain("📜");
  });

  it("shows type emoji prefix for files", () => {
    const result = formatReferences([
      { label: "src/auth.ts", url: "https://github.com/a/b/blob/main/src/auth.ts", type: "file" },
    ]);
    expect(result).toContain("📄");
  });

  it("shows type emoji prefix for docs", () => {
    const result = formatReferences([
      { label: "docs/setup.md", url: "https://github.com/a/b/blob/main/docs/setup.md", type: "doc" },
    ]);
    expect(result).toContain("📖");
  });

  it("deduplicates by label (case-insensitive)", () => {
    const result = formatReferences([
      { label: "Dockerfile", url: "https://github.com/a/b/blob/main/Dockerfile", type: "file" },
      { label: "Dockerfile", url: "https://github.com/a/b/blob/main/Dockerfile", type: "file" },
      { label: "dockerfile", url: "https://github.com/a/b/blob/other/Dockerfile", type: "file" },
    ]);
    const bullets = result.match(/•/g);
    expect(bullets?.length).toBe(1);
  });

  it("caps at MAX_REFERENCES and shows overflow count", () => {
    const refs = Array.from({ length: 18 }, (_, i) => ({
      label: `file${i}.ts`,
      url: `https://github.com/a/b/blob/main/file${i}.ts`,
      type: "file" as const,
    }));
    const result = formatReferences(refs);
    const bullets = result.match(/•/g);
    expect(bullets?.length).toBe(MAX_REFERENCES);
    expect(result).toMatch(/and \d+ more/);
  });

  it("does not show overflow when refs fit within limit", () => {
    const refs = [
      { label: "a.ts", url: "https://example.com/a.ts", type: "file" as const },
      { label: "b.ts", url: "https://example.com/b.ts", type: "file" as const },
    ];
    const result = formatReferences(refs);
    expect(result).not.toContain("more");
  });

  it("MAX_REFERENCES is 10", () => {
    expect(MAX_REFERENCES).toBe(10);
  });

  it("includes feedback hint after references", () => {
    const result = formatReferences([
      { label: "a.ts", url: "https://example.com/a.ts", type: "file" },
    ]);
    expect(result).toContain("👍");
    expect(result).toContain("👎");
  });

  it("no feedback hint when no references", () => {
    expect(formatReferences([])).toBe("");
  });
});
