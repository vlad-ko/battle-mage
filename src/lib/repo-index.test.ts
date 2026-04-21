import { describe, it, expect } from "vitest";
import {
  classifyTopics,
  isIndexStale,
  buildIndexSummary,
  extractDocTitle,
  filterDocPaths,
  buildDocCatalogSection,
  MAX_DOC_CATALOG_ENTRIES,
} from "./repo-index";

describe("classifyTopics", () => {
  it("classifies auth-related files", () => {
    const paths = ["src/services/auth/login.ts", "src/config/auth.ts", "README.md"];
    const topics = classifyTopics(paths);
    expect(topics["authentication"]).toContain("src/services/auth/login.ts");
    expect(topics["authentication"]).toContain("src/config/auth.ts");
    expect(topics["authentication"]).not.toContain("README.md");
  });

  it("classifies deployment files", () => {
    const paths = ["Dockerfile", "docs/deployment/setup.md", ".github/workflows/deploy.yml"];
    const topics = classifyTopics(paths);
    expect(topics["deployment"]).toContain("Dockerfile");
    expect(topics["deployment"]).toContain("docs/deployment/setup.md");
    expect(topics["deployment"]).toContain(".github/workflows/deploy.yml");
  });

  it("classifies database/migration files", () => {
    const paths = ["db/migrations/001_create_users.sql", "src/config/database.ts"];
    const topics = classifyTopics(paths);
    expect(topics["database"]).toContain("db/migrations/001_create_users.sql");
    expect(topics["database"]).toContain("src/config/database.ts");
  });

  it("classifies test files", () => {
    const paths = ["tests/auth/login.test.ts", "spec/models/user.spec.ts"];
    const topics = classifyTopics(paths);
    expect(topics["testing"]).toContain("tests/auth/login.test.ts");
    expect(topics["testing"]).toContain("spec/models/user.spec.ts");
  });

  it("classifies documentation files", () => {
    const paths = ["docs/architecture/overview.md", "README.md", "CLAUDE.md"];
    const topics = classifyTopics(paths);
    expect(topics["documentation"]).toContain("docs/architecture/overview.md");
    expect(topics["documentation"]).toContain("README.md");
  });

  it("classifies CI/CD files", () => {
    const paths = [".github/workflows/ci.yml", ".circleci/config.yml"];
    const topics = classifyTopics(paths);
    expect(topics["ci-cd"]).toContain(".github/workflows/ci.yml");
  });

  it("classifies API/routing files", () => {
    const paths = ["src/routes/api.ts", "src/controllers/UserController.ts"];
    const topics = classifyTopics(paths);
    expect(topics["api"]).toContain("src/routes/api.ts");
    expect(topics["api"]).toContain("src/controllers/UserController.ts");
  });

  it("classifies security scanning files", () => {
    const paths = [
      ".github/workflows/security-scan.yml",
      "app/Security/IpBlocker.ts",
      "infra/scc-sync.tf",
    ];
    const topics = classifyTopics(paths);
    expect(topics["security"]).toContain(".github/workflows/security-scan.yml");
    expect(topics["security"]).toContain("app/Security/IpBlocker.ts");
    expect(topics["security"]).toContain("infra/scc-sync.tf");
  });

  it("classifies CI security tools by name", () => {
    const paths = [
      ".github/workflows/gitguardian.yml",
      ".github/workflows/checkov-scan.yml",
      ".github/workflows/trivy.yml",
    ];
    const topics = classifyTopics(paths);
    expect(topics["security"]).toContain(".github/workflows/gitguardian.yml");
    expect(topics["security"]).toContain(".github/workflows/checkov-scan.yml");
    expect(topics["security"]).toContain(".github/workflows/trivy.yml");
  });

  it("security files can also appear in ci-cd topic", () => {
    const paths = [".github/workflows/security-scan.yml"];
    const topics = classifyTopics(paths);
    expect(topics["security"]).toContain(".github/workflows/security-scan.yml");
    expect(topics["ci-cd"]).toContain(".github/workflows/security-scan.yml");
  });

  it("classifies configuration files", () => {
    const paths = ["config/app.json", ".env.example", "docker-compose.yml"];
    const topics = classifyTopics(paths);
    expect(topics["configuration"]).toContain("config/app.json");
    expect(topics["configuration"]).toContain(".env.example");
  });

  it("does not crash on empty input", () => {
    const topics = classifyTopics([]);
    expect(Object.keys(topics).length).toBe(0);
  });

  it("ignores vendor/node_modules paths", () => {
    const paths = ["vendor/some-lib/auth.js", "node_modules/express/index.js", "src/auth.ts"];
    const topics = classifyTopics(paths);
    // vendor and node_modules files should not appear in any topic
    const allPaths = Object.values(topics).flat();
    expect(allPaths).not.toContain("vendor/some-lib/auth.js");
    expect(allPaths).not.toContain("node_modules/express/index.js");
    expect(allPaths).toContain("src/auth.ts");
  });

  it("ignores .claude/ tooling paths", () => {
    const paths = [".claude/skills/wizard/SKILL.md", ".claude/settings.json", "src/auth.ts"];
    const topics = classifyTopics(paths);
    const allPaths = Object.values(topics).flat();
    expect(allPaths).not.toContain(".claude/skills/wizard/SKILL.md");
    expect(allPaths).not.toContain(".claude/settings.json");
    expect(allPaths).toContain("src/auth.ts");
  });

  it("a file can appear in multiple topics", () => {
    const paths = ["tests/auth/login.test.ts"];
    const topics = classifyTopics(paths);
    // This is both a test file AND auth-related
    expect(topics["testing"]).toContain("tests/auth/login.test.ts");
    expect(topics["authentication"]).toContain("tests/auth/login.test.ts");
  });

  describe("with config annotations", () => {
    const config = {
      paths: {
        "src/": "core" as const,
        "docs/": "current" as const,
        "docs/archive/": "historic" as const,
        "vendor/": "vendor" as const,
        "node_modules/": "excluded" as const,
      },
    };

    it("excludes paths annotated as 'excluded'", () => {
      const paths = ["src/auth.ts", "node_modules/express/index.js"];
      const topics = classifyTopics(paths, config);
      const allPaths = Object.values(topics).flat();
      expect(allPaths).toContain("src/auth.ts");
      expect(allPaths).not.toContain("node_modules/express/index.js");
    });

    it("routes historic paths to _historic pseudo-topic", () => {
      const paths = ["docs/archive/old-notes.md", "docs/setup.md"];
      const topics = classifyTopics(paths, config);
      expect(topics["_historic"]).toContain("docs/archive/old-notes.md");
      // docs/setup.md is "current" so it should go to normal topics
      expect(topics["_historic"] || []).not.toContain("docs/setup.md");
    });

    it("routes vendor paths to _vendor pseudo-topic", () => {
      const paths = ["vendor/lib/util.js", "src/app.ts"];
      const topics = classifyTopics(paths, config);
      expect(topics["_vendor"]).toContain("vendor/lib/util.js");
      const allNonVendor = Object.entries(topics)
        .filter(([k]) => k !== "_vendor")
        .flatMap(([, v]) => v);
      expect(allNonVendor).not.toContain("vendor/lib/util.js");
    });

    it("classifies core/current paths normally", () => {
      const paths = ["src/services/auth/login.ts"];
      const topics = classifyTopics(paths, config);
      expect(topics["authentication"]).toContain("src/services/auth/login.ts");
      expect(topics["_historic"] || []).not.toContain("src/services/auth/login.ts");
    });
  });
});

describe("isIndexStale", () => {
  it("returns true when SHAs differ", () => {
    expect(isIndexStale("abc123", "def456")).toBe(true);
  });

  it("returns false when SHAs match", () => {
    expect(isIndexStale("abc123", "abc123")).toBe(false);
  });

  it("returns true when stored SHA is null (no index exists)", () => {
    expect(isIndexStale("abc123", null)).toBe(true);
  });
});

describe("buildIndexSummary", () => {
  it("formats topics as a compact text summary", () => {
    const topics = {
      authentication: ["src/services/auth/login.ts", "src/config/auth.ts"],
      deployment: ["Dockerfile"],
    };
    const summary = buildIndexSummary(topics);
    expect(summary).toContain("authentication");
    expect(summary).toContain("src/services/auth/login.ts");
    expect(summary).toContain("deployment");
    expect(summary).toContain("Dockerfile");
  });

  it("returns empty string for empty topics", () => {
    expect(buildIndexSummary({})).toBe("");
  });

  it("caps file paths per topic to keep summary compact", () => {
    const topics = {
      testing: Array.from({ length: 20 }, (_, i) => `tests/test${i}.ts`),
    };
    const summary = buildIndexSummary(topics);
    const lines = summary.split("\n");
    expect(lines.length).toBeLessThan(30);
  });

  it("shows pseudo-topics with hints", () => {
    const topics = {
      authentication: ["src/auth.ts"],
      _historic: ["docs/archive/old.md"],
      _vendor: ["vendor/lib.js"],
    };
    const summary = buildIndexSummary(topics);
    expect(summary).toContain("historic");
    expect(summary).toContain("history questions");
    expect(summary).toContain("vendor");
    expect(summary).toContain("dependency questions");
  });

  it("sorts regular topics before pseudo-topics", () => {
    const topics = {
      _historic: ["docs/archive/old.md"],
      authentication: ["src/auth.ts"],
    };
    const summary = buildIndexSummary(topics);
    const lines = summary.split("\n");
    expect(lines[0]).toContain("authentication");
    expect(lines[1]).toContain("historic");
  });
});

describe("extractDocTitle (path-only, #108)", () => {
  // Content-fetching was removed to eliminate the 260-call GitHub fan-out.
  // Title now comes purely from the path basename.

  it("title-cases the basename stem with dashes → spaces", () => {
    expect(extractDocTitle("docs/features/repo-index.md")).toBe("Repo Index");
  });

  it("strips the .md extension (case-insensitive)", () => {
    expect(extractDocTitle("docs/README.MD")).toBe("README");
    expect(extractDocTitle("docs/setup.md")).toBe("Setup");
  });

  it("handles multi-dash basenames", () => {
    expect(extractDocTitle("docs/how-to-deploy-to-prod.md")).toBe(
      "How To Deploy To Prod",
    );
  });

  it("handles underscores as word separators", () => {
    expect(extractDocTitle("docs/my_feature_notes.md")).toBe("My Feature Notes");
  });

  it("handles a mix of dashes and underscores", () => {
    expect(extractDocTitle("docs/ci-cd_setup.md")).toBe("Ci Cd Setup");
  });

  it("handles a top-level docs file with no nesting", () => {
    expect(extractDocTitle("docs/architecture.md")).toBe("Architecture");
  });

  it("handles a single-word basename", () => {
    expect(extractDocTitle("docs/overview.md")).toBe("Overview");
  });
});

describe("filterDocPaths", () => {
  it("keeps docs/**/*.md and excludes other paths", () => {
    const paths = [
      "docs/setup.md",
      "docs/features/kb.md",
      "src/auth.ts",
      "README.md",
      "docs/architecture.md",
    ];
    const result = filterDocPaths(paths);
    expect(result).toEqual([
      "docs/setup.md",
      "docs/features/kb.md",
      "docs/architecture.md",
    ]);
  });

  it("also accepts uppercase .MD (Markdown case-insensitivity)", () => {
    const paths = ["docs/README.MD", "docs/setup.md"];
    const result = filterDocPaths(paths);
    expect(result).toContain("docs/README.MD");
    expect(result).toContain("docs/setup.md");
  });

  it("returns empty array when no docs exist", () => {
    expect(filterDocPaths(["src/auth.ts", "README.md"])).toEqual([]);
  });

  it("respects config excluded paths", () => {
    // BattleMageConfig.paths is Record<prefix, PathAnnotation> — the
    // annotation is the VALUE, not `{ annotation: ... }`. See config.ts.
    const config = { paths: { "docs/internal/": "excluded" as const } };
    const paths = ["docs/setup.md", "docs/internal/secret.md"];
    expect(filterDocPaths(paths, config)).toEqual(["docs/setup.md"]);
  });

  it("respects config historic paths", () => {
    const config = { paths: { "docs/archive/": "historic" as const } };
    const paths = ["docs/setup.md", "docs/archive/old.md"];
    expect(filterDocPaths(paths, config)).toEqual(["docs/setup.md"]);
  });

  it("does not match CLAUDE.md (kept inline, not in docs/)", () => {
    const paths = ["CLAUDE.md", "docs/setup.md"];
    expect(filterDocPaths(paths)).toEqual(["docs/setup.md"]);
  });
});

describe("buildDocCatalogSection", () => {
  it("renders a markdown section listing each entry", () => {
    const entries = [
      { path: "docs/architecture.md", title: "Architecture" },
      { path: "docs/setup.md", title: "Setup Guide" },
    ];
    const section = buildDocCatalogSection(entries);
    expect(section).toContain("## Documentation Index");
    expect(section).toContain("- `docs/architecture.md` — Architecture");
    expect(section).toContain("- `docs/setup.md` — Setup Guide");
  });

  it("includes guidance about how to load docs", () => {
    const entries = [{ path: "docs/x.md", title: "X" }];
    const section = buildDocCatalogSection(entries);
    // Must tell the model to pull content via read_file when needed.
    expect(section).toContain("read_file");
  });

  it("returns empty string for empty input", () => {
    expect(buildDocCatalogSection([])).toBe("");
  });

  it("preserves entry order", () => {
    const entries = [
      { path: "docs/b.md", title: "B doc" },
      { path: "docs/a.md", title: "A doc" },
      { path: "docs/c.md", title: "C doc" },
    ];
    const section = buildDocCatalogSection(entries);
    const bIdx = section.indexOf("docs/b.md");
    const aIdx = section.indexOf("docs/a.md");
    const cIdx = section.indexOf("docs/c.md");
    expect(bIdx).toBeLessThan(aIdx);
    expect(aIdx).toBeLessThan(cIdx);
  });

  it("caps entries at MAX_DOC_CATALOG_ENTRIES and appends an overflow note", () => {
    const entries = Array.from(
      { length: MAX_DOC_CATALOG_ENTRIES + 5 },
      (_, i) => ({ path: `docs/d${i}.md`, title: `D${i}` }),
    );
    const section = buildDocCatalogSection(entries);
    // First 30 present
    expect(section).toContain("docs/d0.md");
    expect(section).toContain(`docs/d${MAX_DOC_CATALOG_ENTRIES - 1}.md`);
    // Last 5 NOT rendered as entries (caught only by the overflow note)
    expect(section).not.toContain(`\`docs/d${MAX_DOC_CATALOG_ENTRIES}.md\``);
    // Overflow note reports remaining count + escape hatch
    expect(section).toContain(`+5 more`);
    expect(section).toContain("read_file");
  });

  it("omits the overflow note when entries are at or below the cap", () => {
    const entries = Array.from(
      { length: MAX_DOC_CATALOG_ENTRIES },
      (_, i) => ({ path: `docs/d${i}.md`, title: `D${i}` }),
    );
    const section = buildDocCatalogSection(entries);
    expect(section).not.toContain("more docs");
  });
});
