import { describe, it, expect } from "vitest";
import { formatReferences, rankReferences, MAX_REFERENCES } from "./references";

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

  it("MAX_REFERENCES is 7", () => {
    expect(MAX_REFERENCES).toBe(7);
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

describe("rankReferences", () => {
  it("ranks source code files above docs", () => {
    const refs = [
      { label: "docs/setup.md", url: "https://example.com/docs", type: "doc" as const },
      { label: "src/auth.ts", url: "https://example.com/auth", type: "file" as const },
    ];
    const ranked = rankReferences(refs, "some answer");
    expect(ranked[0].label).toBe("src/auth.ts");
    expect(ranked[1].label).toBe("docs/setup.md");
  });

  it("ranks test files above docs but below source code", () => {
    const refs = [
      { label: "docs/setup.md", url: "https://example.com/docs", type: "doc" as const },
      { label: "tests/auth.test.ts", url: "https://example.com/test", type: "file" as const },
      { label: "src/auth.ts", url: "https://example.com/auth", type: "file" as const },
    ];
    const ranked = rankReferences(refs, "some answer");
    expect(ranked[0].label).toBe("src/auth.ts");
    expect(ranked[1].label).toBe("tests/auth.test.ts");
    expect(ranked[2].label).toBe("docs/setup.md");
  });

  it("boosts refs cited in the answer text", () => {
    const refs = [
      { label: "#100 Uncited issue", url: "https://example.com/100", type: "issue" as const },
      { label: "#200 Cited issue", url: "https://example.com/200", type: "issue" as const },
    ];
    const ranked = rankReferences(refs, "As seen in #200, the fix was applied");
    expect(ranked[0].label).toContain("#200");
  });

  it("ranks uncited issues/PRs/commits last", () => {
    const refs = [
      { label: "#50 Random issue", url: "https://example.com/50", type: "issue" as const },
      { label: "src/index.ts", url: "https://example.com/src", type: "file" as const },
      { label: "#99 Another issue", url: "https://example.com/99", type: "issue" as const },
    ];
    const ranked = rankReferences(refs, "some answer about index.ts");
    expect(ranked[0].type).toBe("file");
    expect(ranked[ranked.length - 1].type).toBe("issue");
  });

  it("returns empty array for empty input", () => {
    expect(rankReferences([], "answer")).toEqual([]);
  });

  it("maintains order within same tier", () => {
    const refs = [
      { label: "src/a.ts", url: "https://example.com/a", type: "file" as const },
      { label: "src/b.ts", url: "https://example.com/b", type: "file" as const },
      { label: "src/c.ts", url: "https://example.com/c", type: "file" as const },
    ];
    const ranked = rankReferences(refs, "answer");
    expect(ranked.map((r) => r.label)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("cited doc ranks above uncited doc", () => {
    const refs = [
      { label: "docs/old.md", url: "https://example.com/old", type: "doc" as const },
      { label: "docs/cited.md", url: "https://example.com/cited", type: "doc" as const },
    ];
    const ranked = rankReferences(refs, "as documented in docs/cited.md");
    expect(ranked[0].label).toBe("docs/cited.md");
  });
});
