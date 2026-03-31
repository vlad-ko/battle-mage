import { describe, it, expect } from "vitest";
import { formatProgressMessage, buildThinkingMessage, THINKING_HEADER } from "./progress";

describe("formatProgressMessage", () => {
  it("formats initial thinking step", () => {
    const msg = formatProgressMessage("thinking", {});
    expect(msg).toContain("🧠");
    expect(msg).toMatch(/_.*thinking/i);
  });

  it("formats index check step", () => {
    const msg = formatProgressMessage("index", {});
    expect(msg).toContain("🗂️");
    expect(msg).toMatch(/_.*index/i);
  });

  it("formats search_code with query", () => {
    const msg = formatProgressMessage("search_code", { query: "authentication middleware" });
    expect(msg).toContain("🔍");
    expect(msg).toContain("authentication middleware");
  });

  it("formats read_file with path", () => {
    const msg = formatProgressMessage("read_file", { path: "app/Services/Auth/LoginService.php" });
    expect(msg).toContain("👓");
    expect(msg).toContain("app/Services/Auth/LoginService.php");
  });

  it("formats list_issues", () => {
    const msg = formatProgressMessage("list_issues", {});
    expect(msg).toContain("🎫");
  });

  it("formats save_knowledge", () => {
    const msg = formatProgressMessage("save_knowledge", {});
    expect(msg).toContain("💾");
  });

  it("formats create_issue", () => {
    const msg = formatProgressMessage("create_issue", {});
    expect(msg).toContain("📝");
  });

  it("formats composing step", () => {
    const msg = formatProgressMessage("composing", {});
    expect(msg).toContain("✏️");
    expect(msg).toMatch(/_.*composing/i);
  });

  it("all messages are italic (wrapped in underscores)", () => {
    const steps = ["thinking", "index", "search_code", "read_file", "composing"];
    for (const step of steps) {
      const msg = formatProgressMessage(step, {});
      // Slack italics: starts with _ and ends with _
      expect(msg).toMatch(/^.+_.*_$/);
    }
  });

  it("handles unknown tool name gracefully", () => {
    const msg = formatProgressMessage("unknown_tool", {});
    expect(msg).toContain("🧠");
    expect(msg).toMatch(/_/); // still italic
  });

  it("truncates long file paths", () => {
    const msg = formatProgressMessage("read_file", {
      path: "very/deeply/nested/directory/structure/that/goes/on/forever/file.php",
    });
    expect(msg.length).toBeLessThan(120);
  });
});

describe("buildThinkingMessage", () => {
  it("includes the fixed header on every message", () => {
    const msg = buildThinkingMessage("search_code", { query: "auth" });
    expect(msg).toContain(THINKING_HEADER);
  });

  it("includes the status line below the header", () => {
    const msg = buildThinkingMessage("search_code", { query: "auth" });
    const lines = msg.split("\n");
    expect(lines[0]).toBe(THINKING_HEADER);
    expect(lines[1]).toContain("🔍");
    expect(lines[1]).toContain("auth");
  });

  it("header stays the same regardless of tool", () => {
    const msg1 = buildThinkingMessage("search_code", { query: "x" });
    const msg2 = buildThinkingMessage("read_file", { path: "y" });
    const header1 = msg1.split("\n")[0];
    const header2 = msg2.split("\n")[0];
    expect(header1).toBe(header2);
  });
});
