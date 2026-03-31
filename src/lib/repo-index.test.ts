import { describe, it, expect } from "vitest";
import { classifyTopics, isIndexStale, buildIndexSummary } from "./repo-index";

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

  it("a file can appear in multiple topics", () => {
    const paths = ["tests/auth/login.test.ts"];
    const topics = classifyTopics(paths);
    // This is both a test file AND auth-related
    expect(topics["testing"]).toContain("tests/auth/login.test.ts");
    expect(topics["authentication"]).toContain("tests/auth/login.test.ts");
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
    // Should not list all 20 files — capped for prompt size
    const lines = summary.split("\n");
    // Total output should be manageable (under 30 lines for a single topic)
    expect(lines.length).toBeLessThan(30);
  });
});
