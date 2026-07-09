import { describe, it, expect } from "vitest";
import {
  isEmbeddableSourcePath,
  chunkCodeFile,
  MAX_CODE_CHUNK_CHARS,
  MAX_EMBED_FILE_BYTES,
} from "./code-chunker";
import type { BattleMageConfig } from "./config";

const noConfig: BattleMageConfig = { paths: {} };

describe("isEmbeddableSourcePath", () => {
  it("accepts allowlisted source extensions", () => {
    expect(isEmbeddableSourcePath("src/lib/foo.ts", 100, noConfig)).toBe(true);
    expect(isEmbeddableSourcePath("app/Http/Kernel.php", 100, noConfig)).toBe(true);
  });

  it("rejects markdown (docs arm owns prose), json/yaml/lock noise, and tooling paths", () => {
    expect(isEmbeddableSourcePath("docs/setup.md", 100, noConfig)).toBe(false);
    expect(isEmbeddableSourcePath("package-lock.json", 100, noConfig)).toBe(false);
    expect(isEmbeddableSourcePath("config/app.yaml", 100, noConfig)).toBe(false);
    expect(isEmbeddableSourcePath(".claude/skills/wizard/SKILL.md", 100, noConfig)).toBe(false);
    expect(isEmbeddableSourcePath("public/vendor.min.js", 100, noConfig)).toBe(false);
  });

  it("rejects excluded/vendor/historic config annotations (S6 predicate)", () => {
    const config: BattleMageConfig = {
      paths: { "vendor/": "vendor", "archive/": "historic", "secrets/": "excluded" },
    };
    expect(isEmbeddableSourcePath("vendor/lib/a.php", 100, config)).toBe(false);
    expect(isEmbeddableSourcePath("archive/old.ts", 100, config)).toBe(false);
    expect(isEmbeddableSourcePath("secrets/keys.ts", 100, config)).toBe(false);
    expect(isEmbeddableSourcePath("src/a.ts", 100, config)).toBe(true);
  });

  it("size boundary: at cap eligible, one over rejected, undefined size eligible", () => {
    expect(isEmbeddableSourcePath("src/a.ts", MAX_EMBED_FILE_BYTES, noConfig)).toBe(true);
    expect(isEmbeddableSourcePath("src/a.ts", MAX_EMBED_FILE_BYTES + 1, noConfig)).toBe(false);
    expect(isEmbeddableSourcePath("src/a.ts", undefined, noConfig)).toBe(true);
  });
});

describe("chunkCodeFile — TS/JS section-aware", () => {
  it("returns [] for empty and whitespace-only content", () => {
    expect(chunkCodeFile("src/a.ts", "")).toEqual([]);
    expect(chunkCodeFile("src/a.ts", "   \n\n  ")).toEqual([]);
  });

  it("packs a small file into one chunk with full line range and path-prefixed text", () => {
    const content = `import { x } from "./x";\n\nexport function alpha() {\n  return 1;\n}\n`;
    const chunks = chunkCodeFile("src/a.ts", content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe("src/a.ts#0");
    expect(chunks[0].text.startsWith("src/a.ts\n\n")).toBe(true);
    expect(chunks[0].metadata).toMatchObject({ path: "src/a.ts", startLine: 1, endLine: 5 });
  });

  it("splits at a column-0 declaration boundary when packing would exceed the cap", () => {
    // Two ~1000-char top-level functions: together they bust the 1500 cap,
    // so the split must land EXACTLY on the second boundary line.
    const filler = "  // padding padding padding padding padding\n".repeat(21); // ~966 chars
    const alpha = `export function alpha() {\n${filler}}\n`;
    const beta = `export function beta() {\n${filler}}\n`;
    const chunks = chunkCodeFile("src/a.ts", alpha + beta);
    expect(chunks).toHaveLength(2);
    const alphaLines = alpha.split("\n").length - 1; // 23
    expect(chunks[0].metadata.endLine).toBe(alphaLines);
    expect(chunks[1].metadata.startLine).toBe(alphaLines + 1);
    expect(chunks[1].text).toContain("export function beta()");
    expect(chunks[1].id).toBe("src/a.ts#1");
  });

  it("indented declarations are NOT boundaries (column-0 heuristic)", () => {
    const content = `export function outer() {\n  const inner = () => 1;\n  function nested() {}\n}\n`;
    expect(chunkCodeFile("src/a.ts", content)).toHaveLength(1);
  });

  it("caps every chunk's text at MAX_CODE_CHUNK_CHARS unconditionally", () => {
    const oneLongLine = "x".repeat(4000); // single oversized segment → hard slice
    const chunks = chunkCodeFile("src/a.ts", oneLongLine);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX_CODE_CHUNK_CHARS);
  });
});

describe("chunkCodeFile — line-window fallback (non-TS/JS)", () => {
  it("packs whole lines greedily; chunk line ranges are contiguous and ordinals sequential", () => {
    const line = "$sum = $sum + 1; // ".padEnd(99, "p"); // 99 chars + \n
    const content = Array.from({ length: 45 }, () => line).join("\n"); // ~4500 chars
    const chunks = chunkCodeFile("app/calc.php", content);
    expect(chunks).toHaveLength(4); // budget = 1500 - len("app/calc.php") - 2 = 1486 → 14 lines/chunk
    chunks.forEach((c, i) => expect(c.id).toBe(`app/calc.php#${i}`));
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].metadata.startLine).toBe(chunks[i - 1].metadata.endLine + 1);
    }
    expect(chunks[0].metadata.startLine).toBe(1);
    expect(chunks[chunks.length - 1].metadata.endLine).toBe(45);
  });

  it("excerpt is whitespace-collapsed and capped at 160 chars", () => {
    const content = "line  one\n\n\nline    two " + "z".repeat(300);
    const [chunk] = chunkCodeFile("app/calc.php", content.slice(0, 400));
    expect(chunk.metadata.excerpt.length).toBeLessThanOrEqual(160);
    expect(chunk.metadata.excerpt).not.toMatch(/\s{2,}/);
    expect(chunk.metadata.excerpt.startsWith("line one")).toBe(true);
  });
});
