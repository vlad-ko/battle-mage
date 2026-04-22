import { describe, it, expect } from "vitest";
import { capSlackMessage, SLACK_MESSAGE_BYTE_CAP } from "./slack";

// Helper — UTF-8 byte length of a string.
function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

describe("capSlackMessage (byte-based)", () => {
  it("passes through short ASCII messages unchanged", () => {
    const text = "hello world";
    expect(capSlackMessage(text)).toBe(text);
  });

  it("passes through messages exactly at the byte cap unchanged", () => {
    const text = "a".repeat(SLACK_MESSAGE_BYTE_CAP);
    expect(bytes(text)).toBe(SLACK_MESSAGE_BYTE_CAP);
    expect(capSlackMessage(text)).toBe(text);
  });

  it("truncates when over the byte cap and appends a user-facing note", () => {
    const text = "a".repeat(SLACK_MESSAGE_BYTE_CAP + 5_000);
    const result = capSlackMessage(text);
    expect(bytes(result)).toBeLessThanOrEqual(SLACK_MESSAGE_BYTE_CAP);
    expect(result).toMatch(/cut off|truncated/i);
    expect(result).toContain("Slack");
    expect(result).toMatch(/follow.up|narrower/i);
  });

  it("enforces byte budget on unicode-heavy content (the real-world bug)", () => {
    // An em-dash `—` is 3 bytes in UTF-8. 20_000 em-dashes = 60_000 bytes
    // but only 20_000 JavaScript chars — the failure mode that the old
    // char-based cap missed (#110 post-merge reproduction). The byte cap
    // must enforce byte count.
    const text = "—".repeat(20_000);
    expect(bytes(text)).toBe(60_000);
    expect(text.length).toBe(20_000);

    const result = capSlackMessage(text);
    expect(bytes(result)).toBeLessThanOrEqual(SLACK_MESSAGE_BYTE_CAP);
    expect(result).toMatch(/cut off|truncated/i);
  });

  it("preserves the start of the content (truncates from the end)", () => {
    const head = "IMPORTANT: the agent's analysis begins here.\n\n";
    const filler = "x".repeat(SLACK_MESSAGE_BYTE_CAP + 5_000);
    const text = head + filler;

    const result = capSlackMessage(text);
    expect(result.startsWith(head)).toBe(true);
  });

  it("handles emoji-heavy content (4 bytes per emoji) correctly", () => {
    // 🧠 is U+1F9E0, encoded as 4 UTF-8 bytes. 10_000 of them = 40_000 bytes
    // (over the 36K cap) but only 20_000 UTF-16 code units (JS length).
    const text = "🧠".repeat(10_000);
    expect(bytes(text)).toBe(40_000);

    const result = capSlackMessage(text);
    expect(bytes(result)).toBeLessThanOrEqual(SLACK_MESSAGE_BYTE_CAP);
    expect(result).toMatch(/cut off|truncated/i);
  });

  it("never corrupts the output when the cut falls inside a multi-byte char", () => {
    // Construct a string whose byte length right at the budget boundary
    // falls mid-character. TextDecoder with fatal:false handles this by
    // substituting U+FFFD for the partial sequence, so the result is
    // always valid UTF-8 (no half-chars, no throw).
    const prefix = "a".repeat(SLACK_MESSAGE_BYTE_CAP - 100);
    // Append a run of 3-byte em-dashes whose middle falls past the cut.
    const text = prefix + "—".repeat(200);
    const result = capSlackMessage(text);

    // Must be valid UTF-8; no partial sequence should survive.
    // Re-encoding the result should not throw and should match expected bytes.
    expect(() => new TextEncoder().encode(result)).not.toThrow();
    expect(bytes(result)).toBeLessThanOrEqual(SLACK_MESSAGE_BYTE_CAP);
  });

  it("handles messages only slightly over the cap", () => {
    const text = "a".repeat(SLACK_MESSAGE_BYTE_CAP + 1);
    const result = capSlackMessage(text);
    expect(bytes(result)).toBeLessThanOrEqual(SLACK_MESSAGE_BYTE_CAP);
    expect(result).toMatch(/cut off|truncated/i);
  });

  it("SLACK_MESSAGE_BYTE_CAP leaves headroom under Slack's 40k limit", () => {
    // Slack's documented limit for `text` is 40_000; we stay well under so
    // the JSON envelope (channel, thread_ts, token header, message
    // metadata) has room and unicode expansion can't cross the cliff.
    expect(SLACK_MESSAGE_BYTE_CAP).toBeLessThan(40_000);
    expect(SLACK_MESSAGE_BYTE_CAP).toBeGreaterThan(25_000);
  });
});
