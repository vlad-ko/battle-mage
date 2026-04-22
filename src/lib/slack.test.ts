import { describe, it, expect } from "vitest";
import {
  requireSlackMessageText,
  SLACK_MESSAGE_CHAR_LIMIT,
  SlackMessageOversizeError,
} from "./slack";

describe("requireSlackMessageText (fail-loud boundary guard)", () => {
  it("returns the text unchanged when under the limit", () => {
    const text = "hello world";
    expect(requireSlackMessageText(text, "chat.postMessage")).toBe(text);
  });

  it("returns the text unchanged when exactly at the limit", () => {
    const text = "a".repeat(SLACK_MESSAGE_CHAR_LIMIT);
    expect(requireSlackMessageText(text, "chat.postMessage")).toBe(text);
  });

  it("throws SlackMessageOversizeError when over the limit", () => {
    const text = "a".repeat(SLACK_MESSAGE_CHAR_LIMIT + 1);
    expect(() => requireSlackMessageText(text, "chat.update")).toThrow(
      SlackMessageOversizeError,
    );
  });

  it("error message names the action and the actual length", () => {
    const text = "x".repeat(SLACK_MESSAGE_CHAR_LIMIT + 500);
    try {
      requireSlackMessageText(text, "chat.postMessage");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SlackMessageOversizeError);
      const msg = (e as Error).message;
      expect(msg).toContain("chat.postMessage");
      expect(msg).toContain(String(SLACK_MESSAGE_CHAR_LIMIT + 500));
      expect(msg).toContain("40000");
    }
  });

  it("SLACK_MESSAGE_CHAR_LIMIT matches Slack's documented 40_000 limit", () => {
    // Anchor value — changing this should be a conscious decision that
    // surfaces in code review, not a silent drift.
    expect(SLACK_MESSAGE_CHAR_LIMIT).toBe(40_000);
  });

  it("unicode content counts as characters, not bytes (matches Slack's count)", () => {
    // 20K em-dashes = 20,000 chars but 60,000 UTF-8 bytes. Should PASS
    // the guard (chars-based), whereas the old byte-based cap would
    // have truncated it.
    const text = "—".repeat(20_000);
    expect(text.length).toBe(20_000);
    expect(() => requireSlackMessageText(text, "chat.postMessage")).not.toThrow();
  });

  it("emoji (surrogate pairs) count each pair as 2 chars (UTF-16 length)", () => {
    // 🧠 is one grapheme but 2 UTF-16 code units. 20K emoji = 40_000 chars.
    // Slack's limit is applied via `.length` which counts code units, so
    // this should be exactly at the limit.
    const text = "🧠".repeat(20_000);
    expect(text.length).toBe(40_000);
    expect(() => requireSlackMessageText(text, "chat.postMessage")).not.toThrow();
    // One more character pushes us over.
    const overText = text + "x";
    expect(() => requireSlackMessageText(overText, "chat.postMessage")).toThrow(
      SlackMessageOversizeError,
    );
  });
});
