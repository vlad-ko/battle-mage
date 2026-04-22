import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  requireSlackMessageText,
  SLACK_MESSAGE_CHAR_LIMIT,
  SlackMessageOversizeError,
  postReplyInChunks,
  slack,
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

// ── Multi-chunk delivery (#114) ──────────────────────────────────────
describe("postReplyInChunks returns every posted TS", () => {
  let postCounter = 0;

  beforeEach(() => {
    postCounter = 0;
    vi.spyOn(slack.chat, "postMessage").mockImplementation(
      (async () => ({ ok: true, ts: `9999.${postCounter++}` })) as never,
    );
    vi.spyOn(slack.chat, "update").mockResolvedValue({ ok: true } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty allTs for empty text", async () => {
    const result = await postReplyInChunks({ channel: "C1", threadTs: "T1", text: "" });
    expect(result.chunks).toBe(0);
    expect(result.firstTs).toBeUndefined();
    expect(result.allTs).toEqual([]);
  });

  it("single-chunk (with thinkingTs) returns the thinkingTs in allTs", async () => {
    const result = await postReplyInChunks({
      channel: "C1",
      threadTs: "T1",
      thinkingTs: "THINK.1",
      text: "short answer",
    });
    expect(result.chunks).toBe(1);
    expect(result.firstTs).toBe("THINK.1");
    expect(result.allTs).toEqual(["THINK.1"]);
  });

  it("single-chunk (no thinkingTs) returns the newly-posted TS", async () => {
    const result = await postReplyInChunks({
      channel: "C1",
      threadTs: "T1",
      text: "short answer",
    });
    expect(result.chunks).toBe(1);
    expect(result.firstTs).toBe("9999.0");
    expect(result.allTs).toEqual(["9999.0"]);
  });

  it("multi-chunk returns thinkingTs as chunk 0 plus every new-reply TS", async () => {
    // Force a 3-chunk split with a large body (>> default 3K).
    const bigText = "x".repeat(8_500);
    const result = await postReplyInChunks({
      channel: "C1",
      threadTs: "T1",
      thinkingTs: "THINK.1",
      text: bigText,
    });
    expect(result.chunks).toBeGreaterThanOrEqual(3);
    expect(result.firstTs).toBe("THINK.1");
    expect(result.allTs[0]).toBe("THINK.1");
    // Subsequent chunks are fresh posts with TS from the counter
    expect(result.allTs.length).toBe(result.chunks);
    for (let i = 1; i < result.chunks; i++) {
      expect(result.allTs[i]).toMatch(/^9999\.\d+$/);
    }
    // Crucially: allTs contains UNIQUE values so per-chunk KV writes
    // don't collide on the same key.
    expect(new Set(result.allTs).size).toBe(result.allTs.length);
  });

  it("allTs length matches chunks exactly (no orphans, no dupes)", async () => {
    const bigText = "y".repeat(7_000);
    const result = await postReplyInChunks({
      channel: "C1",
      threadTs: "T1",
      text: bigText,
    });
    expect(result.allTs.length).toBe(result.chunks);
  });
});
