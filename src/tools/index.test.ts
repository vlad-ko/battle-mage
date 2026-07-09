import { describe, it, expect, vi } from "vitest";

// #127: the search_repo routing test exercises the real executor with
// its network-touching arms stubbed. importOriginal keeps every other
// export intact for the sibling tool modules.
const { searchCodeSpy } = vi.hoisted(() => ({
  searchCodeSpy: vi.fn(async (..._a: unknown[]) => [
    { path: "src/auth.ts", url: "https://github.com/acme/backend/blob/main/src/auth.ts", score: 3 },
  ]),
}));
vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  searchCode: (...a: unknown[]) => searchCodeSpy(...a),
}));
vi.mock("@/lib/repo-index", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDocsVectorNamespace: vi.fn(async () => null),
}));

import { tools, executeTool } from "./index";

describe("tools registry — prompt caching", () => {
  it("has all 8 tools", () => {
    expect(tools).toHaveLength(8);
  });

  it("registers search_repo (#127)", () => {
    expect(tools.map((t) => t.name)).toContain("search_repo");
  });

  it("invariant T1: exactly ONE tool carries cache_control, and it is the LAST array element", () => {
    // Anthropic caches every block up to and including the one marked with
    // cache_control. Marking only the last tool caches the entire tools array.
    const last = tools[tools.length - 1];
    expect(last.cache_control, "last tool must mark the cache breakpoint").toEqual({
      type: "ephemeral",
    });
    for (let i = 0; i < tools.length - 1; i++) {
      expect(
        tools[i].cache_control,
        `tool[${i}] (${tools[i].name}) must not carry cache_control`,
      ).toBeUndefined();
    }
  });
});

describe("executeTool — search_repo routing (#127)", () => {
  it("routes search_repo to its executor and returns a text result", async () => {
    const result = await executeTool("search_repo", { query: "auth" });
    expect(result.type).toBe("text");
    if (result.type === "text") {
      expect(result.text).toContain("src/auth.ts");
      expect(result.references).toEqual([]);
    }
    expect(searchCodeSpy).toHaveBeenCalledWith("auth");
  });
});
