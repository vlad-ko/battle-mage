import { describe, it, expect } from "vitest";
import { matchTopicsToQuestion, buildQuestionHints } from "./topic-match";
import type { TopicMap } from "./repo-index";

const sampleTopics: TopicMap = {
  authentication: ["src/services/auth/login.ts", "src/config/auth.ts", "tests/auth/login.test.ts"],
  deployment: ["Dockerfile", "docs/deployment/setup.md", ".github/workflows/deploy.yml"],
  database: ["db/migrations/001_create_users.sql", "src/config/database.ts"],
  security: [".github/workflows/security-scan.yml", "src/Security/IpBlocker.ts"],
  configuration: ["docs/development/local-setup.md", "docs/setup/development.md", "config/app.json"],
};

describe("matchTopicsToQuestion", () => {
  it("matches 'authentication' topic for auth questions", () => {
    const matches = matchTopicsToQuestion("how does authentication work?", sampleTopics);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].topic).toBe("authentication");
  });

  it("matches 'deployment' topic for deploy questions", () => {
    const matches = matchTopicsToQuestion("how do we deploy to production?", sampleTopics);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.topic === "deployment")).toBe(true);
  });

  it("matches 'security' topic for security questions", () => {
    const matches = matchTopicsToQuestion("what is our security posture?", sampleTopics);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.topic === "security")).toBe(true);
  });

  it("matches by file path keywords too", () => {
    const matches = matchTopicsToQuestion("tell me about the local setup process", sampleTopics);
    expect(matches.length).toBeGreaterThan(0);
    // "setup" appears in configuration topic file paths
    expect(matches.some((m) => m.topic === "configuration")).toBe(true);
  });

  it("returns empty array for unrelated questions", () => {
    const matches = matchTopicsToQuestion("what is the meaning of life?", sampleTopics);
    expect(matches).toHaveLength(0);
  });

  it("returns top file paths per matched topic (capped)", () => {
    const matches = matchTopicsToQuestion("how does auth work?", sampleTopics);
    if (matches.length > 0) {
      expect(matches[0].paths.length).toBeLessThanOrEqual(3);
    }
  });

  it("handles empty topics gracefully", () => {
    expect(matchTopicsToQuestion("anything", {})).toHaveLength(0);
  });

  it("handles empty question gracefully", () => {
    expect(matchTopicsToQuestion("", sampleTopics)).toHaveLength(0);
  });
});

describe("buildQuestionHints", () => {
  it("returns augmented message with file paths", () => {
    const matches = [
      { topic: "authentication", paths: ["src/services/auth/login.ts", "src/config/auth.ts"] },
    ];
    const result = buildQuestionHints("how does auth work?", matches);
    expect(result).toContain("how does auth work?");
    expect(result).toContain("src/services/auth/login.ts");
    expect(result).toContain("read_file");
  });

  it("returns original question when no matches", () => {
    const result = buildQuestionHints("random question", []);
    expect(result).toBe("random question");
  });

  it("includes topic name for context", () => {
    const matches = [
      { topic: "deployment", paths: ["Dockerfile"] },
    ];
    const result = buildQuestionHints("how to deploy?", matches);
    expect(result).toContain("deployment");
  });
});
