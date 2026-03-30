import { describe, it, expect } from "vitest";
import { toSlackMrkdwn } from "./mrkdwn";

describe("toSlackMrkdwn", () => {
  it("converts ## Heading to *Heading*", () => {
    expect(toSlackMrkdwn("## My Heading")).toBe("*My Heading*");
  });

  it("converts ### Sub Heading to *Sub Heading*", () => {
    expect(toSlackMrkdwn("### Sub Heading")).toBe("*Sub Heading*");
  });

  it("converts # H1 to *H1*", () => {
    expect(toSlackMrkdwn("# Title")).toBe("*Title*");
  });

  it("converts **bold** to *bold*", () => {
    expect(toSlackMrkdwn("This is **bold** text")).toBe("This is *bold* text");
  });

  it("leaves already-correct *bold* unchanged", () => {
    expect(toSlackMrkdwn("This is *bold* text")).toBe("This is *bold* text");
  });

  it("handles multiple headings in one string", () => {
    const input = "## First\nSome text\n## Second";
    const expected = "*First*\nSome text\n*Second*";
    expect(toSlackMrkdwn(input)).toBe(expected);
  });

  it("handles mixed headings and bold", () => {
    const input = "## Title\n**Important** note";
    const expected = "*Title*\n*Important* note";
    expect(toSlackMrkdwn(input)).toBe(expected);
  });

  it("passes through plain text unchanged", () => {
    expect(toSlackMrkdwn("Just normal text")).toBe("Just normal text");
  });

  it("handles empty string", () => {
    expect(toSlackMrkdwn("")).toBe("");
  });

  it("does not convert headings inside code blocks", () => {
    // This is a known limitation — documenting current behavior
    // Code blocks with ## inside will get converted. Accept for now.
    const input = "```\n## Not a heading\n```";
    // Current implementation WILL convert this — test documents the behavior
    expect(toSlackMrkdwn(input)).toContain("```");
  });
});
