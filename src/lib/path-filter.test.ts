import { describe, it, expect } from "vitest";
import { isToolingPath } from "./path-filter";

describe("isToolingPath", () => {
  it("returns true for .claude/ paths", () => {
    expect(isToolingPath(".claude/skills/wizard/SKILL.md")).toBe(true);
    expect(isToolingPath(".claude/settings.json")).toBe(true);
    expect(isToolingPath(".claude/CLAUDE.md")).toBe(true);
  });

  it("returns false for regular project paths", () => {
    expect(isToolingPath("src/auth.ts")).toBe(false);
    expect(isToolingPath("docs/setup.md")).toBe(false);
    expect(isToolingPath("CLAUDE.md")).toBe(false);
  });

  it("returns false for paths that contain claude but aren't .claude/", () => {
    expect(isToolingPath("src/lib/claude.ts")).toBe(false);
    expect(isToolingPath("docs/claude-integration.md")).toBe(false);
  });
});
