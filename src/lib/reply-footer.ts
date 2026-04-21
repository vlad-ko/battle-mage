/**
 * Compact telemetry footer for replies.
 *
 * Appends a single italic Slack line showing duration, token usage, cache
 * metrics, and request ID to answer messages. Disabled by default; enable
 * with `BM_REPLY_FOOTER=1`. Junior's `_45s · 3.2k in · 0.8k out · abc12345_`
 * pattern — turns a black-box agent reply into something you can debug at
 * a glance.
 *
 * See #79.
 */

export interface AgentMetrics {
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  rounds: number;
}

export function formatDurationCompact(ms: number): string {
  if (ms < 1000) return "0s"; // includes negative / zero / sub-second
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m${seconds}s`;
}

export function formatTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) {
    // One decimal place for the 1k-10k range where precision matters.
    const scaled = Math.round(n / 100) / 10;
    return `${scaled.toFixed(1)}k`;
  }
  // Over 10k, round to nearest thousand — precision doesn't help at scale.
  return `${Math.round(n / 1000)}k`;
}

export function formatReplyFooter(metrics: AgentMetrics, requestId: string): string {
  const parts: string[] = [];
  parts.push(formatDurationCompact(metrics.duration_ms));
  parts.push(`${formatTokensCompact(metrics.input_tokens)} in`);
  parts.push(`${formatTokensCompact(metrics.output_tokens)} out`);
  if (metrics.cache_read_tokens > 0) {
    parts.push(`${formatTokensCompact(metrics.cache_read_tokens)} cached`);
  }
  parts.push(requestId.slice(0, 8));
  // Leading newline provides visual separation from any preceding block
  // (references footer, proposal body) without forcing every caller to
  // add their own.
  return `\n_${parts.join(" · ")}_`;
}

/**
 * Reads BM_REPLY_FOOTER from the given env. Accepts "1", "true" (any case)
 * as truthy. Takes an env object for testability — pass `process.env` in
 * production.
 */
export function isReplyFooterEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env.BM_REPLY_FOOTER;
  if (!raw) return false;
  const normalized = raw.toLowerCase();
  return normalized === "1" || normalized === "true";
}
