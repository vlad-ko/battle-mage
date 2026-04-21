import { describe, it, expect } from "vitest";
import {
  formatReplyFooter,
  formatDurationCompact,
  formatTokensCompact,
  isReplyFooterEnabled,
  type AgentMetrics,
} from "./reply-footer";

const baseMetrics: AgentMetrics = {
  duration_ms: 45_000,
  input_tokens: 3_200,
  output_tokens: 820,
  cache_read_tokens: 500,
  cache_creation_tokens: 0,
  rounds: 3,
};

describe("formatDurationCompact", () => {
  it("formats sub-second durations as 0s", () => {
    expect(formatDurationCompact(420)).toBe("0s");
  });

  it("formats seconds as Ns", () => {
    expect(formatDurationCompact(1_000)).toBe("1s");
    expect(formatDurationCompact(45_000)).toBe("45s");
    expect(formatDurationCompact(59_999)).toBe("59s");
  });

  it("formats minutes+seconds as MmSs for >= 1 minute", () => {
    expect(formatDurationCompact(60_000)).toBe("1m0s");
    expect(formatDurationCompact(65_000)).toBe("1m5s");
    expect(formatDurationCompact(125_000)).toBe("2m5s");
  });

  it("handles zero cleanly", () => {
    expect(formatDurationCompact(0)).toBe("0s");
  });

  it("handles negative as 0s (defensive)", () => {
    // runAgent could theoretically produce a negative if clocks jump —
    // defensively clamp rather than show `-5s`.
    expect(formatDurationCompact(-1000)).toBe("0s");
  });
});

describe("formatTokensCompact", () => {
  it("formats small values (<1000) as integer", () => {
    expect(formatTokensCompact(0)).toBe("0");
    expect(formatTokensCompact(500)).toBe("500");
    expect(formatTokensCompact(999)).toBe("999");
  });

  it("formats 1k-10k with one decimal place", () => {
    expect(formatTokensCompact(1_000)).toBe("1.0k");
    expect(formatTokensCompact(3_200)).toBe("3.2k");
    expect(formatTokensCompact(9_900)).toBe("9.9k");
  });

  it("formats 10k+ without decimals", () => {
    expect(formatTokensCompact(10_000)).toBe("10k");
    expect(formatTokensCompact(48_500)).toBe("49k"); // rounds
    expect(formatTokensCompact(150_000)).toBe("150k");
  });
});

describe("formatReplyFooter", () => {
  it("returns a single italic Slack line with all metrics", () => {
    const footer = formatReplyFooter(baseMetrics, "abc12345");
    // Slack italic: _..._ — stripped of the leading newline (separator
    // from the preceding block), the rest is on one line.
    const content = footer.replace(/^\n/, "");
    expect(content).toMatch(/^_.*_$/);
    expect(content).not.toContain("\n");
  });

  it("includes duration, input tokens, output tokens, request ID", () => {
    const footer = formatReplyFooter(baseMetrics, "abc12345");
    expect(footer).toContain("45s");
    expect(footer).toContain("3.2k in");
    expect(footer).toContain("820 out");
    expect(footer).toContain("abc12345");
  });

  it("omits cache_read when zero", () => {
    const metrics = { ...baseMetrics, cache_read_tokens: 0 };
    const footer = formatReplyFooter(metrics, "abc12345");
    expect(footer).not.toContain("cached");
  });

  it("includes cache_read when non-zero", () => {
    const footer = formatReplyFooter(baseMetrics, "abc12345");
    expect(footer).toContain("500 cached");
  });

  it("truncates long request IDs to first 8 chars", () => {
    const footer = formatReplyFooter(baseMetrics, "0123456789abcdef");
    expect(footer).toContain("01234567");
    expect(footer).not.toContain("89abcdef");
  });

  it("handles short request IDs gracefully (no padding)", () => {
    const footer = formatReplyFooter(baseMetrics, "abc");
    expect(footer).toContain("abc");
  });

  it("uses middot separators between fields", () => {
    const footer = formatReplyFooter(baseMetrics, "abc12345");
    // At least two middots expected: duration · in · out · id
    expect(footer.match(/·/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("starts with a leading newline so it drops below the preceding block", () => {
    // Route will concatenate the footer after references; a leading newline
    // ensures visual separation without the caller having to add one.
    const footer = formatReplyFooter(baseMetrics, "abc12345");
    expect(footer.startsWith("\n")).toBe(true);
  });
});

describe("isReplyFooterEnabled", () => {
  it("returns true when BM_REPLY_FOOTER is \"1\"", () => {
    expect(isReplyFooterEnabled({ BM_REPLY_FOOTER: "1" })).toBe(true);
  });

  it("returns true when BM_REPLY_FOOTER is \"true\"", () => {
    expect(isReplyFooterEnabled({ BM_REPLY_FOOTER: "true" })).toBe(true);
  });

  it("is case-insensitive on \"true\"", () => {
    expect(isReplyFooterEnabled({ BM_REPLY_FOOTER: "True" })).toBe(true);
    expect(isReplyFooterEnabled({ BM_REPLY_FOOTER: "TRUE" })).toBe(true);
  });

  it("returns false when unset", () => {
    expect(isReplyFooterEnabled({})).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isReplyFooterEnabled({ BM_REPLY_FOOTER: "" })).toBe(false);
  });

  it("returns false for \"0\" or \"false\"", () => {
    expect(isReplyFooterEnabled({ BM_REPLY_FOOTER: "0" })).toBe(false);
    expect(isReplyFooterEnabled({ BM_REPLY_FOOTER: "false" })).toBe(false);
  });
});
