import { describe, it, expect } from "vitest";
import { assembleSystemPrompt, MAX_TOOL_ROUNDS } from "./claude";

describe("assembleSystemPrompt", () => {
  const baseArgs = {
    owner: "acme",
    repo: "backend",
    claudeMd: null,
    knowledge: null,
    feedback: null,
    repoIndex: null,
  };

  describe("source-of-truth hierarchy", () => {
    it("includes the hierarchy section in the prompt", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).toContain("Source-of-Truth Hierarchy");
    });

    it("lists all five levels in correct order", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      const hierarchySection = prompt.slice(
        prompt.indexOf("Source-of-Truth Hierarchy"),
      );

      // Each level must appear, and in the correct order
      const levels = [
        "Source code",
        "Tests",
        "Documentation",
        "Knowledge base",
        "Feedback signals",
      ];

      let lastIndex = -1;
      for (const level of levels) {
        const index = hierarchySection.indexOf(level);
        expect(index, `"${level}" not found in hierarchy`).toBeGreaterThan(-1);
        expect(
          index,
          `"${level}" appears before a higher-priority level`,
        ).toBeGreaterThan(lastIndex);
        lastIndex = index;
      }
    });

    it("instructs to flag discrepancies between code and KB", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      // The prompt must tell the agent to flag when KB contradicts code
      expect(prompt).toMatch(/code.*contradicts|contradicts.*code|discrepancy|conflict/i);
    });

    it("instructs to flag discrepancies between code and docs", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      // The prompt must tell the agent to flag when docs contradict code
      expect(prompt).toMatch(/doc.*contradict|contradict.*doc|doc.*discrepancy|doc.*stale|doc.*drift/i);
    });

    it("instructs to verify against code before asserting KB or doc claims", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).toMatch(/verify.*code|check.*code.*before|code.*authoritative|code.*source of truth/i);
    });
  });

  describe("context sections", () => {
    it("includes CLAUDE.md when provided", () => {
      const prompt = assembleSystemPrompt({
        ...baseArgs,
        claudeMd: "# My Project\nLaravel + GCP",
      });
      expect(prompt).toContain("Laravel + GCP");
      expect(prompt).toContain("Project Context");
    });

    it("omits CLAUDE.md section when null", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).not.toContain("Project Context");
    });

    it("includes knowledge base when provided", () => {
      const prompt = assembleSystemPrompt({
        ...baseArgs,
        knowledge: "- [2026-03-30] Auth lives in app/Services/Auth",
      });
      expect(prompt).toContain("Auth lives in app/Services/Auth");
      expect(prompt).toContain("Knowledge Base");
    });

    it("omits knowledge data section when null", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      // The tool instructions ("Knowledge Base — IMPORTANT") are always present,
      // but the data section with actual entries should be absent
      expect(prompt).not.toContain("learned corrections");
    });

    it("includes feedback when provided", () => {
      const prompt = assembleSystemPrompt({
        ...baseArgs,
        feedback: "*What worked well:*\n- concise answers",
      });
      expect(prompt).toContain("concise answers");
      expect(prompt).toContain("Feedback");
    });

    it("omits feedback section when null", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).not.toContain("User Feedback");
    });

    it("includes repo index when provided", () => {
      const prompt = assembleSystemPrompt({
        ...baseArgs,
        repoIndex: "- *authentication*: app/Services/Auth/\n- *deployment*: Dockerfile",
      });
      expect(prompt).toContain("Repository Map");
      expect(prompt).toContain("app/Services/Auth/");
      expect(prompt).toContain("Dockerfile");
    });

    it("omits repo index section when null", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).not.toContain("Repository Map");
    });

    it("includes owner and repo in prompt", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).toContain("acme");
      expect(prompt).toContain("backend");
    });
  });

  describe("search strategy", () => {
    it("includes search strategy section in the prompt", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).toMatch(/search strategy/i);
    });

    it("instructs to use search_code before read_file", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      // search_code must be recommended as the first step
      expect(prompt).toMatch(/search.*before.*read|search.*first|search_code.*before.*read_file/i);
    });

    it("instructs to synthesize early, not exhaust all rounds", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      // Must mention answering with what you have rather than exhausting tool calls
      expect(prompt).toMatch(/synthesize|answer.*early|partial answer|don.t.*exhaust|budget/i);
    });

    it("instructs to suggest follow-ups for broad questions", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).toMatch(/follow.up|narrow.*question|suggest.*specific|dig deeper/i);
    });

    it("mentions the tool round limit explicitly", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      // The agent should know how many rounds it has
      expect(prompt).toContain(String(MAX_TOOL_ROUNDS));
    });
  });

  describe("MAX_TOOL_ROUNDS", () => {
    it("is set to 15", () => {
      expect(MAX_TOOL_ROUNDS).toBe(15);
    });
  });

  describe("hierarchy labels match context sections", () => {
    it("knowledge section warns it can become stale", () => {
      const prompt = assembleSystemPrompt({
        ...baseArgs,
        knowledge: "- some fact",
      });
      // The KB section or hierarchy must mention staleness
      expect(prompt).toMatch(/stale|drift|outdated|may.*change/i);
    });

    it("feedback section is labeled as weakest signal", () => {
      const prompt = assembleSystemPrompt({
        ...baseArgs,
        feedback: "- some feedback",
      });
      expect(prompt).toMatch(/weak|subjective|lowest|least.*authoritative/i);
    });
  });
});
