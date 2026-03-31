import { describe, it, expect } from "vitest";
import {
  parseBattleMageConfig,
  getAnnotation,
  filterPathsByAnnotation,
  type BattleMageConfig,
  type PathAnnotation,
} from "./config";

describe("parseBattleMageConfig", () => {
  it("parses valid config JSON", () => {
    const json = '{"paths":{"src/":"core","vendor/":"vendor"}}';
    const config = parseBattleMageConfig(json);
    expect(config.paths["src/"]).toBe("core");
    expect(config.paths["vendor/"]).toBe("vendor");
  });

  it("returns empty config for null input", () => {
    const config = parseBattleMageConfig(null);
    expect(Object.keys(config.paths)).toHaveLength(0);
  });

  it("returns empty config for invalid JSON", () => {
    const config = parseBattleMageConfig("not json {{{");
    expect(Object.keys(config.paths)).toHaveLength(0);
  });

  it("returns empty config when paths field missing", () => {
    const config = parseBattleMageConfig('{"other":"field"}');
    expect(Object.keys(config.paths)).toHaveLength(0);
  });

  it("ignores invalid annotation values", () => {
    const config = parseBattleMageConfig('{"paths":{"src/":"core","bad/":"invalid_type"}}');
    expect(config.paths["src/"]).toBe("core");
    expect(config.paths["bad/"]).toBeUndefined();
  });
});

describe("getAnnotation", () => {
  const config: BattleMageConfig = {
    paths: {
      "src/": "core",
      "docs/": "current",
      "docs/archive/": "historic",
      "vendor/": "vendor",
      "node_modules/": "excluded",
    },
  };

  it("returns annotation for exact prefix match", () => {
    expect(getAnnotation("src/auth.ts", config)).toBe("core");
    expect(getAnnotation("vendor/lib/index.js", config)).toBe("vendor");
  });

  it("returns most specific (longest) prefix match", () => {
    // docs/ is "current" but docs/archive/ is "historic"
    expect(getAnnotation("docs/setup.md", config)).toBe("current");
    expect(getAnnotation("docs/archive/old.md", config)).toBe("historic");
  });

  it("returns 'current' for unannotated paths", () => {
    expect(getAnnotation("README.md", config)).toBe("current");
    expect(getAnnotation("Dockerfile", config)).toBe("current");
  });

  it("returns 'current' for empty config", () => {
    expect(getAnnotation("anything.ts", { paths: {} })).toBe("current");
  });

  it("handles nested paths correctly", () => {
    expect(getAnnotation("docs/archive/2025/notes.md", config)).toBe("historic");
  });
});

describe("filterPathsByAnnotation", () => {
  const config: BattleMageConfig = {
    paths: {
      "src/": "core",
      "docs/": "current",
      "docs/archive/": "historic",
      "vendor/": "vendor",
      "node_modules/": "excluded",
    },
  };

  const allPaths = [
    "src/auth.ts",
    "src/index.ts",
    "docs/setup.md",
    "docs/archive/old.md",
    "vendor/lib/index.js",
    "node_modules/express/index.js",
    "README.md",
  ];

  it("excludes paths annotated as 'excluded'", () => {
    const filtered = filterPathsByAnnotation(allPaths, config, ["excluded"]);
    expect(filtered).not.toContain("node_modules/express/index.js");
    expect(filtered).toContain("src/auth.ts");
  });

  it("can exclude multiple annotation types", () => {
    const filtered = filterPathsByAnnotation(allPaths, config, ["excluded", "vendor"]);
    expect(filtered).not.toContain("node_modules/express/index.js");
    expect(filtered).not.toContain("vendor/lib/index.js");
    expect(filtered).toContain("src/auth.ts");
  });

  it("returns all paths when no exclusions specified", () => {
    const filtered = filterPathsByAnnotation(allPaths, config, []);
    expect(filtered).toHaveLength(allPaths.length);
  });

  it("returns all paths for empty config", () => {
    const filtered = filterPathsByAnnotation(allPaths, { paths: {} }, ["excluded"]);
    expect(filtered).toHaveLength(allPaths.length);
  });

  it("preserves order of remaining paths", () => {
    const filtered = filterPathsByAnnotation(allPaths, config, ["excluded", "vendor"]);
    expect(filtered[0]).toBe("src/auth.ts");
    expect(filtered[filtered.length - 1]).toBe("README.md");
  });
});
