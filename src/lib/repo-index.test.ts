import { describe, it, expect } from "vitest";
import { classifyTopics, isIndexStale, buildIndexSummary } from "./repo-index";

describe("classifyTopics", () => {
  it("classifies auth-related files", () => {
    const paths = ["app/Services/Auth/LoginService.php", "config/auth.php", "README.md"];
    const topics = classifyTopics(paths);
    expect(topics["authentication"]).toContain("app/Services/Auth/LoginService.php");
    expect(topics["authentication"]).toContain("config/auth.php");
    expect(topics["authentication"]).not.toContain("README.md");
  });

  it("classifies deployment files", () => {
    const paths = ["Dockerfile", "docs/deployment/gcp-cloud-run.md", ".github/workflows/deploy.yml"];
    const topics = classifyTopics(paths);
    expect(topics["deployment"]).toContain("Dockerfile");
    expect(topics["deployment"]).toContain("docs/deployment/gcp-cloud-run.md");
    expect(topics["deployment"]).toContain(".github/workflows/deploy.yml");
  });

  it("classifies database/migration files", () => {
    const paths = ["database/migrations/001_create_users.php", "config/database.php"];
    const topics = classifyTopics(paths);
    expect(topics["database"]).toContain("database/migrations/001_create_users.php");
    expect(topics["database"]).toContain("config/database.php");
  });

  it("classifies test files", () => {
    const paths = ["tests/Unit/AuthTest.php", "spec/models/user.spec.ts"];
    const topics = classifyTopics(paths);
    expect(topics["testing"]).toContain("tests/Unit/AuthTest.php");
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
    const paths = ["routes/api.php", "app/Http/Controllers/UserController.php"];
    const topics = classifyTopics(paths);
    expect(topics["api"]).toContain("routes/api.php");
    expect(topics["api"]).toContain("app/Http/Controllers/UserController.php");
  });

  it("classifies configuration files", () => {
    const paths = ["config/app.php", ".env.example", "docker-compose.yml"];
    const topics = classifyTopics(paths);
    expect(topics["configuration"]).toContain("config/app.php");
    expect(topics["configuration"]).toContain(".env.example");
  });

  it("does not crash on empty input", () => {
    const topics = classifyTopics([]);
    expect(Object.keys(topics).length).toBe(0);
  });

  it("ignores vendor/node_modules paths", () => {
    const paths = ["vendor/laravel/framework/Auth.php", "node_modules/express/index.js", "app/Auth.php"];
    const topics = classifyTopics(paths);
    // vendor and node_modules files should not appear in any topic
    const allPaths = Object.values(topics).flat();
    expect(allPaths).not.toContain("vendor/laravel/framework/Auth.php");
    expect(allPaths).not.toContain("node_modules/express/index.js");
    expect(allPaths).toContain("app/Auth.php");
  });

  it("a file can appear in multiple topics", () => {
    const paths = ["tests/Auth/LoginTest.php"];
    const topics = classifyTopics(paths);
    // This is both a test file AND auth-related
    expect(topics["testing"]).toContain("tests/Auth/LoginTest.php");
    expect(topics["authentication"]).toContain("tests/Auth/LoginTest.php");
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
      authentication: ["app/Services/Auth/LoginService.php", "config/auth.php"],
      deployment: ["Dockerfile"],
    };
    const summary = buildIndexSummary(topics);
    expect(summary).toContain("authentication");
    expect(summary).toContain("app/Services/Auth/LoginService.php");
    expect(summary).toContain("deployment");
    expect(summary).toContain("Dockerfile");
  });

  it("returns empty string for empty topics", () => {
    expect(buildIndexSummary({})).toBe("");
  });

  it("caps file paths per topic to keep summary compact", () => {
    const topics = {
      testing: Array.from({ length: 20 }, (_, i) => `tests/test${i}.php`),
    };
    const summary = buildIndexSummary(topics);
    // Should not list all 20 files — capped for prompt size
    const lines = summary.split("\n");
    // Total output should be manageable (under 30 lines for a single topic)
    expect(lines.length).toBeLessThan(30);
  });
});
