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
    const references = ["app/Services/Auth/LoginService.php", "config/auth.php"];
    const kbEntries: KnowledgeEntry[] = [
      { entry: "The auth module lives in app/Services/Auth, not app/Http/Auth", timestamp: "2026-03-28" },
      { entry: "Database migrations use timestamps not sequential IDs", timestamp: "2026-03-29" },
    ];

    const stale = identifyStaleKBEntries(references, kbEntries);
    expect(stale).toHaveLength(1);
    expect(stale[0].entry).toContain("auth");
  });

  it("matches KB entries by topic keywords, not just exact paths", () => {
    const references = ["app/Http/Controllers/AuthController.php"];
    const kbEntries: KnowledgeEntry[] = [
      { entry: "Auth uses Laravel Sanctum, not Passport", timestamp: "2026-03-28" },
      { entry: "Redis cache TTL is 3600 seconds", timestamp: "2026-03-29" },
    ];

    const stale = identifyStaleKBEntries(references, kbEntries);
    expect(stale).toHaveLength(1);
    expect(stale[0].entry).toContain("Auth");
  });

  it("returns empty array when no KB entries match", () => {
    const references = ["app/Models/User.php"];
    const kbEntries: KnowledgeEntry[] = [
      { entry: "Deploy uses Docker Alpine, not Ubuntu", timestamp: "2026-03-28" },
    ];

    const stale = identifyStaleKBEntries(references, kbEntries);
    expect(stale).toHaveLength(0);
  });

  it("returns empty array when no KB entries exist", () => {
    const stale = identifyStaleKBEntries(["app/Models/User.php"], []);
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
      "app/Models/User.php",
      "docs/deployment/gcp-cloud-run.md",
      "README.md",
      "config/auth.php",
    ];

    const stale = identifyStaleDocReferences(references);
    expect(stale).toContain("docs/deployment/gcp-cloud-run.md");
    expect(stale).toContain("README.md");
    expect(stale).not.toContain("app/Models/User.php");
    expect(stale).not.toContain("config/auth.php");
  });

  it("returns empty array when no doc references", () => {
    const stale = identifyStaleDocReferences(["app/Models/User.php", "config/auth.php"]);
    expect(stale).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    expect(identifyStaleDocReferences([])).toHaveLength(0);
  });
});

describe("buildCorrectionActions", () => {
  it("returns KB removals when stale KB entries found", () => {
    const actions = buildCorrectionActions(
      ["app/Services/Auth/LoginService.php"],
      [{ entry: "Auth lives in app/Services/Auth", timestamp: "2026-03-28" }],
    );
    expect(actions.kbEntriesToRemove).toHaveLength(1);
    expect(actions.kbEntriesToRemove[0].entry).toContain("Auth");
  });

  it("returns doc fix proposals when doc references found", () => {
    const actions = buildCorrectionActions(
      ["docs/deployment/gcp-cloud-run.md", "app/Models/User.php"],
      [],
    );
    expect(actions.docsToProposeFix).toContain("docs/deployment/gcp-cloud-run.md");
    expect(actions.docsToProposeFix).not.toContain("app/Models/User.php");
  });

  it("returns both KB removals and doc proposals when both apply", () => {
    const actions = buildCorrectionActions(
      ["docs/deployment/gcp-cloud-run.md", "app/Services/Auth/LoginService.php"],
      [{ entry: "Auth uses Sanctum", timestamp: "2026-03-28" }],
    );
    expect(actions.kbEntriesToRemove.length).toBeGreaterThan(0);
    expect(actions.docsToProposeFix.length).toBeGreaterThan(0);
  });

  it("returns empty actions when nothing to correct", () => {
    const actions = buildCorrectionActions(
      ["app/Models/User.php"],
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
      ["app/Models/User.php"],
      [],
    );
    expect(actions.hasActions).toBe(false);
  });
});
