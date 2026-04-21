import { describe, it, expect } from "vitest";
import { capSlackMessage, SLACK_MESSAGE_HARD_CAP } from "./slack";

describe("capSlackMessage", () => {
  it("passes through messages under the cap unchanged", () => {
    const text = "hello world";
    expect(capSlackMessage(text)).toBe(text);
  });

  it("passes through messages exactly at the cap unchanged", () => {
    const text = "a".repeat(SLACK_MESSAGE_HARD_CAP);
    expect(capSlackMessage(text)).toBe(text);
  });

  it("truncates and appends a note when over the cap", () => {
    const text = "a".repeat(SLACK_MESSAGE_HARD_CAP + 5_000);
    const result = capSlackMessage(text);
    // Final length must fit under the hard cap.
    expect(result.length).toBeLessThanOrEqual(SLACK_MESSAGE_HARD_CAP);
    // Must carry a truncation note so the user knows they got a partial.
    expect(result).toMatch(/truncated/);
    expect(result).toContain("Slack");
  });

  it("preserves the start of the content (truncates from the end)", () => {
    const head = "IMPORTANT: The agent's analysis begins here.\n\n";
    const filler = "x".repeat(SLACK_MESSAGE_HARD_CAP + 5_000);
    const text = head + filler;

    const result = capSlackMessage(text);
    expect(result.startsWith(head)).toBe(true);
  });

  it("handles messages only slightly over the cap", () => {
    const text = "a".repeat(SLACK_MESSAGE_HARD_CAP + 1);
    const result = capSlackMessage(text);
    expect(result.length).toBeLessThanOrEqual(SLACK_MESSAGE_HARD_CAP);
    expect(result).toMatch(/truncated/);
  });

  it("handles very-oversized messages without allocating uncontrollably", () => {
    // 1 MB body — bigger than anything the agent could realistically produce,
    // but if it happens we must still return a sane capped result, not hang.
    const text = "x".repeat(1_000_000);
    const result = capSlackMessage(text);
    expect(result.length).toBeLessThanOrEqual(SLACK_MESSAGE_HARD_CAP);
  });

  it("SLACK_MESSAGE_HARD_CAP leaves headroom under Slack's 40k limit", () => {
    // Slack's documented limit for `text` on chat.postMessage / chat.update
    // is 40_000. We stay under with margin so the truncation note itself
    // can't push us over.
    expect(SLACK_MESSAGE_HARD_CAP).toBeLessThan(40_000);
    expect(SLACK_MESSAGE_HARD_CAP).toBeGreaterThan(35_000);
  });
});
