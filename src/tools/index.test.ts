import { describe, it, expect } from "vitest";
import { tools } from "./index";

describe("tools registry — prompt caching", () => {
  it("has all 7 tools", () => {
    expect(tools).toHaveLength(7);
  });

  it("caches the tool definitions — only the LAST tool carries cache_control", () => {
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
