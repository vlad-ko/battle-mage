import { describe, it, expect, vi } from "vitest";
import {
  assembleSystemPrompt,
  assembleSystemBlocks,
  safeInvokeTextDelta,
  truncateToolResult,
  MAX_TOOL_ROUNDS,
  TOOL_RESULT_MAX_CHARS,
} from "./claude";

describe("assembleSystemPrompt", () => {
  const baseArgs = {
    owner: "acme",
    repo: "backend",
    claudeMd: null,
    knowledge: null,
    feedback: null,
    repoIndex: null,
    pathAnnotations: null,
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
        claudeMd: "# My Project\nNext.js + PostgreSQL",
      });
      expect(prompt).toContain("Next.js + PostgreSQL");
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

    it("omits repo index data section when null", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      // The search strategy always mentions "Repository Map" as a concept.
      // But the actual data section with topic listings should be absent.
      expect(prompt).not.toContain("auto-generated index");
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

  describe("recency and brevity", () => {
    it("includes today's date in the prompt", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      // Must contain a date in YYYY-MM-DD format
      expect(prompt).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it("instructs to prefer recent activity over historical", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).toMatch(/recent.*first|most recent|last 30 days|newest first/i);
    });

    it("instructs to avoid archived/historical docs unless asked", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).toMatch(/archive.*avoid|archive.*skip|archive.*only.*if.*asked|archive.*historical/i);
    });

    it("instructs to be concise and direct", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).toMatch(/concise|brief|direct|short|15 lines|don.t editorialize/i);
    });

    it("instructs not to write marketing copy or brochure-style", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).toMatch(/no.*brochure|no.*marketing|no.*editorial|skip.*what makes.*special/i);
    });
  });

  describe("path annotations", () => {
    it("injects annotation guidance when config provided", () => {
      const prompt = assembleSystemPrompt({
        ...baseArgs,
        pathAnnotations: {
          paths: {
            "src/": "core",
            "docs/archive/": "historic",
            "vendor/": "vendor",
          },
        },
      });
      expect(prompt).toContain("Path Annotations");
      expect(prompt).toContain("core");
      expect(prompt).toContain("historic");
      expect(prompt).toContain("vendor");
    });

    it("instructs to qualify historic content", () => {
      const prompt = assembleSystemPrompt({
        ...baseArgs,
        pathAnnotations: {
          paths: { "docs/archive/": "historic" },
        },
      });
      expect(prompt).toMatch(/historic.*qualify|historic.*historically/i);
    });

    it("instructs to skip historic/vendor by default", () => {
      const prompt = assembleSystemPrompt({
        ...baseArgs,
        pathAnnotations: {
          paths: { "docs/archive/": "historic", "vendor/": "vendor" },
        },
      });
      expect(prompt).toMatch(/skip.*historic|avoid.*historic|historic.*only.*when/i);
      expect(prompt).toMatch(/skip.*vendor|avoid.*vendor|vendor.*only.*when/i);
    });

    it("omits annotation section when config is null", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).not.toContain("Path Annotations");
    });

    it("omits annotation section when config has empty paths", () => {
      const prompt = assembleSystemPrompt({
        ...baseArgs,
        pathAnnotations: { paths: {} },
      });
      expect(prompt).not.toContain("Path Annotations");
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

  describe("XML structure — stable zone", () => {
    const stableTags = [
      "identity",
      "core-principles",
      "source-hierarchy",
      "tools",
      "search-strategy",
      "knowledge-base-usage",
      "output-contract",
    ];

    it.each(stableTags)("wraps the %s section in matching open/close tags", (tag) => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).toContain(`<${tag}>`);
      expect(prompt).toContain(`</${tag}>`);
    });

    it("emits stable sections in canonical order", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      let last = -1;
      for (const tag of stableTags) {
        const idx = prompt.indexOf(`<${tag}>`);
        expect(idx, `<${tag}> missing`).toBeGreaterThan(-1);
        expect(idx, `<${tag}> out of order`).toBeGreaterThan(last);
        last = idx;
      }
    });

    it("emits the entire stable zone BEFORE any volatile data section", () => {
      // Cache-breakpoint prerequisite: stable content must sit above volatile.
      const prompt = assembleSystemPrompt({
        ...baseArgs,
        claudeMd: "CLAUDE_MARKER_123",
        knowledge: "- [2026-01-01] KB_MARKER_456",
        feedback: "- FEEDBACK_MARKER_789",
        repoIndex: "- *marker*: REPO_INDEX_MARKER_000",
      });
      const contractEnd = prompt.indexOf("</output-contract>");
      expect(contractEnd, "</output-contract> missing").toBeGreaterThan(-1);

      const volatileMarkers = [
        "CLAUDE_MARKER_123",
        "KB_MARKER_456",
        "FEEDBACK_MARKER_789",
        "REPO_INDEX_MARKER_000",
      ];
      for (const marker of volatileMarkers) {
        const idx = prompt.indexOf(marker);
        expect(idx, `${marker} missing`).toBeGreaterThan(-1);
        expect(
          idx,
          `${marker} appears before </output-contract> — breaks caching invariant`,
        ).toBeGreaterThan(contractEnd);
      }
    });
  });

  describe("output contract — anti-narration and Slack mrkdwn constraints", () => {
    it("explicitly bans the phrase 'let me check'", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt.toLowerCase()).toContain("let me check");
    });

    it("bans at least three narration patterns beyond 'let me check'", () => {
      const prompt = assembleSystemPrompt(baseArgs).toLowerCase();
      const banned = [
        "i'll look",
        "one moment",
        "fetching now",
        "hold on",
        "looking into",
        "let me look",
      ];
      const hits = banned.filter((p) => prompt.includes(p));
      expect(
        hits.length,
        `output contract must list ≥3 banned narration phrases, found: ${hits.join(", ")}`,
      ).toBeGreaterThanOrEqual(3);
    });

    it("forbids markdown tables", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).toMatch(/no.*table|never.*table|tables.*break|tables.*broken|avoid.*table/i);
    });

    it("forbids [text](url) markdown link syntax", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      // The literal template "[text](url)" must appear in the ban list so the
      // model sees exactly what NOT to emit.
      expect(prompt).toContain("[text](url)");
    });

    it("instructs to prefer a single result-focused reply after tool work", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      expect(prompt).toMatch(
        /single.*result.focused|result.focused.*reply|after tool.*complete|don.?t pre.?announce/i,
      );
    });

    it("keeps the output contract inside the <output-contract> tag body", () => {
      const prompt = assembleSystemPrompt(baseArgs);
      const start = prompt.indexOf("<output-contract>");
      const end = prompt.indexOf("</output-contract>");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const body = prompt.slice(start, end).toLowerCase();
      // Core contract content must live inside the tag, not floating elsewhere
      expect(body).toContain("let me check");
      expect(body).toContain("[text](url)");
    });
  });
});

describe("assembleSystemBlocks — prompt caching", () => {
  const baseArgs = {
    owner: "acme",
    repo: "backend",
    claudeMd: null,
    knowledge: null,
    feedback: null,
    repoIndex: null,
    pathAnnotations: null,
  };

  it("returns an array of text content blocks", () => {
    const blocks = assembleSystemBlocks(baseArgs);
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(block.type).toBe("text");
      expect(typeof block.text).toBe("string");
      expect(block.text.length).toBeGreaterThan(0);
    }
  });

  it("marks ONLY the stable (first) block with ephemeral cache_control", () => {
    const blocks = assembleSystemBlocks(baseArgs);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    for (let i = 1; i < blocks.length; i++) {
      expect(
        blocks[i].cache_control,
        `block[${i}] must not be cached — it is the volatile zone`,
      ).toBeUndefined();
    }
  });

  it("stable block ends at </output-contract> — nothing volatile above the breakpoint", () => {
    const blocks = assembleSystemBlocks({
      ...baseArgs,
      claudeMd: "CLAUDE_MARKER",
      knowledge: "- KB_MARKER",
      repoIndex: "- *x*: REPO_INDEX_MARKER",
    });
    const stable = blocks[0].text;
    expect(stable).toContain("</output-contract>");
    // None of the volatile markers may leak into the cached block
    expect(stable).not.toContain("CLAUDE_MARKER");
    expect(stable).not.toContain("KB_MARKER");
    expect(stable).not.toContain("REPO_INDEX_MARKER");
    expect(stable).not.toContain("Project Context");
    expect(stable).not.toContain("learned corrections");
  });

  it("volatile block carries repo-context and conditional data", () => {
    const blocks = assembleSystemBlocks({
      ...baseArgs,
      claudeMd: "CLAUDE_MARKER",
      knowledge: "- KB_MARKER",
    });
    const volatile = blocks.slice(1).map((b) => b.text).join("\n");
    expect(volatile).toContain("<repo-context>");
    expect(volatile).toContain("acme");
    expect(volatile).toContain("backend");
    expect(volatile).toContain("CLAUDE_MARKER");
    expect(volatile).toContain("KB_MARKER");
  });

  it("concatenated blocks match assembleSystemPrompt output byte-for-byte", () => {
    // Invariant: the block-based API and the string API produce identical
    // content — only the cache shape differs.
    const inputs = {
      ...baseArgs,
      claudeMd: "# Project\nAll about widgets",
      knowledge: "- a fact",
      feedback: "- some feedback",
      repoIndex: "- *topic*: src/foo.ts",
    };
    const fromBlocks = assembleSystemBlocks(inputs).map((b) => b.text).join("");
    const fromString = assembleSystemPrompt(inputs);
    expect(fromBlocks).toBe(fromString);
  });
});

describe("safeInvokeTextDelta — streaming callback safety", () => {
  it("invokes the callback with the snapshot", async () => {
    const cb = vi.fn();
    safeInvokeTextDelta(cb, "Hello world");
    // Microtask-scheduled — flush the queue
    await Promise.resolve();
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith("Hello world");
  });

  it("is a no-op when the callback is undefined", () => {
    expect(() => safeInvokeTextDelta(undefined, "anything")).not.toThrow();
  });

  it("swallows synchronous throws from the callback", async () => {
    const cb = vi.fn(() => {
      throw new Error("sync boom");
    });
    expect(() => safeInvokeTextDelta(cb, "x")).not.toThrow();
    // Flush the microtask where the callback actually runs
    await Promise.resolve();
    await Promise.resolve();
    expect(cb).toHaveBeenCalled();
  });

  it("swallows async rejections from the callback (no unhandled promise rejection)", async () => {
    const cb = vi.fn(async () => {
      throw new Error("async boom");
    });
    safeInvokeTextDelta(cb, "y");
    // Let the rejection + catch() propagate through the microtask queue
    await Promise.resolve();
    await Promise.resolve();
    expect(cb).toHaveBeenCalled();
    // If the rejection were unhandled, vitest would fail the test here.
  });

  it("supports sync-returning callbacks", async () => {
    let seen = "";
    const cb = (snap: string): void => {
      seen = snap;
    };
    safeInvokeTextDelta(cb, "streamed");
    await Promise.resolve();
    expect(seen).toBe("streamed");
  });

  it("supports async-returning callbacks", async () => {
    let seen = "";
    const cb = async (snap: string): Promise<void> => {
      await Promise.resolve();
      seen = snap;
    };
    safeInvokeTextDelta(cb, "async streamed");
    // Two awaits for the inner await + the outer .then
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toBe("async streamed");
  });
});

describe("truncateToolResult — prevents msg_too_long crashes", () => {
  it("passes through content shorter than the cap", () => {
    const { text, truncated } = truncateToolResult("short content");
    expect(text).toBe("short content");
    expect(truncated).toBe(false);
  });

  it("passes through content exactly at the cap", () => {
    const input = "a".repeat(TOOL_RESULT_MAX_CHARS);
    const { text, truncated } = truncateToolResult(input);
    expect(text).toBe(input);
    expect(truncated).toBe(false);
  });

  it("truncates content longer than the cap", () => {
    const input = "a".repeat(TOOL_RESULT_MAX_CHARS + 5000);
    const { text, truncated } = truncateToolResult(input);
    expect(truncated).toBe(true);
    // Final output should be close to cap — some overhead for the tail suffix
    expect(text.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 1000);
    expect(text.length).toBeGreaterThan(TOOL_RESULT_MAX_CHARS - 1000);
  });

  it("appends a tail suffix that the model can understand", () => {
    const input = "x".repeat(TOOL_RESULT_MAX_CHARS + 100);
    const { text } = truncateToolResult(input);
    // Must explicitly tell the model the result was cut and how to recover
    expect(text.toLowerCase()).toContain("truncated");
    expect(text).toContain(String(input.length));
  });

  it("reports original length in the tail suffix", () => {
    const input = "b".repeat(TOOL_RESULT_MAX_CHARS + 12345);
    const { text } = truncateToolResult(input);
    expect(text).toContain(String(input.length));
  });

  it("is a no-op on empty string", () => {
    const { text, truncated } = truncateToolResult("");
    expect(text).toBe("");
    expect(truncated).toBe(false);
  });

  it("exposes TOOL_RESULT_MAX_CHARS as a constant so callers can budget", () => {
    expect(TOOL_RESULT_MAX_CHARS).toBeGreaterThan(1000);
    expect(TOOL_RESULT_MAX_CHARS).toBeLessThan(200000);
  });
});
