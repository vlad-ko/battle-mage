import { describe, it, expect } from "vitest";
import {
  identifyStaleKBEntries,
  identifyStaleDocReferences,
  type CorrectionActions,
  buildCorrectionActions,
} from "./auto-correct";
import type { KnowledgeEntry } from "./knowledge";

describe("identifyStaleKBEntries", () => {
  it("returns KB entries that mention referenced file paths", () => {
    const references = ["src/services/auth/login.ts", "src/config/auth.ts"];
    const kbEntries: KnowledgeEntry[] = [
      { entry: "The auth module lives in src/services/auth, not src/controllers/auth", timestamp: "2026-03-28" },
      { entry: "Database migrations use timestamps not sequential IDs", timestamp: "2026-03-29" },
    ];

    const stale = identifyStaleKBEntries(references, kbEntries);
    expect(stale).toHaveLength(1);
    expect(stale[0].entry).toContain("auth");
  });

  it("matches KB entries by topic keywords, not just exact paths", () => {
    const references = ["src/controllers/AuthController.ts"];
    const kbEntries: KnowledgeEntry[] = [
      { entry: "Auth uses JWT tokens, not session cookies", timestamp: "2026-03-28" },
      { entry: "Redis cache TTL is 3600 seconds", timestamp: "2026-03-29" },
    ];

    const stale = identifyStaleKBEntries(references, kbEntries);
    expect(stale).toHaveLength(1);
    expect(stale[0].entry).toContain("Auth");
  });

  it("returns empty array when no KB entries match", () => {
    const references = ["src/models/User.ts"];
    const kbEntries: KnowledgeEntry[] = [
      { entry: "Deploy uses nginx, not Apache", timestamp: "2026-03-28" },
    ];

    const stale = identifyStaleKBEntries(references, kbEntries);
    expect(stale).toHaveLength(0);
  });

  it("returns empty array when no KB entries exist", () => {
    const stale = identifyStaleKBEntries(["src/models/User.ts"], []);
    expect(stale).toHaveLength(0);
  });

  it("returns empty array when no references exist", () => {
    const kbEntries: KnowledgeEntry[] = [
      { entry: "Some fact", timestamp: "2026-03-28" },
    ];
    const stale = identifyStaleKBEntries([], kbEntries);
    expect(stale).toHaveLength(0);
  });
});

describe("identifyStaleDocReferences", () => {
  it("returns references that are doc/markdown files", () => {
    const references = [
      "src/models/User.ts",
      "docs/deployment/setup.md",
      "README.md",
      "src/config/auth.ts",
    ];

    const stale = identifyStaleDocReferences(references);
    expect(stale).toContain("docs/deployment/setup.md");
    expect(stale).toContain("README.md");
    expect(stale).not.toContain("src/models/User.ts");
    expect(stale).not.toContain("src/config/auth.ts");
  });

  it("returns empty array when no doc references", () => {
    const stale = identifyStaleDocReferences(["src/models/User.ts", "src/config/auth.ts"]);
    expect(stale).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    expect(identifyStaleDocReferences([])).toHaveLength(0);
  });
});

describe("buildCorrectionActions", () => {
  it("returns KB removals when stale KB entries found", () => {
    const actions = buildCorrectionActions(
      ["src/services/auth/login.ts"],
      [{ entry: "Auth lives in src/services/auth", timestamp: "2026-03-28" }],
    );
    expect(actions.kbEntriesToRemove).toHaveLength(1);
    expect(actions.kbEntriesToRemove[0].entry).toContain("Auth");
  });

  it("returns doc fix proposals when doc references found", () => {
    const actions = buildCorrectionActions(
      ["docs/deployment/setup.md", "src/models/User.ts"],
      [],
    );
    expect(actions.docsToProposeFix).toContain("docs/deployment/setup.md");
    expect(actions.docsToProposeFix).not.toContain("src/models/User.ts");
  });

  it("returns both KB removals and doc proposals when both apply", () => {
    const actions = buildCorrectionActions(
      ["docs/deployment/setup.md", "src/services/auth/login.ts"],
      [{ entry: "Auth uses JWT", timestamp: "2026-03-28" }],
    );
    expect(actions.kbEntriesToRemove.length).toBeGreaterThan(0);
    expect(actions.docsToProposeFix.length).toBeGreaterThan(0);
  });

  it("returns empty actions when nothing to correct", () => {
    const actions = buildCorrectionActions(
      ["src/models/User.ts"],
      [{ entry: "Redis TTL is 3600", timestamp: "2026-03-28" }],
    );
    expect(actions.kbEntriesToRemove).toHaveLength(0);
    expect(actions.docsToProposeFix).toHaveLength(0);
  });

  it("hasActions is true when there are corrections", () => {
    const actions = buildCorrectionActions(
      ["docs/README.md"],
      [],
    );
    expect(actions.hasActions).toBe(true);
  });

  it("hasActions is false when empty", () => {
    const actions = buildCorrectionActions(
      ["src/models/User.ts"],
      [],
    );
    expect(actions.hasActions).toBe(false);
  });
});
