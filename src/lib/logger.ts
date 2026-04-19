/**
 * Structured Logger — JSON output for Vercel function logs.
 *
 * All log entries are JSON objects with:
 * - event: string — what happened
 * - ts: number — unix timestamp
 * - requestId: string — correlates all events in one invocation
 * - ...data: additional context
 *
 * View in Vercel Dashboard > Project > Logs, or `vercel logs --prod`.
 */

export function log(event: string, data?: Record<string, unknown>): void {
  const entry = JSON.stringify({ event, ...data, ts: Date.now() });
  // Use console.error for error events — Vercel shows these at "error" level
  // which makes them filterable and visually distinct in the log viewer
  if (event.includes("error")) {
    console.error(entry);
  } else {
    console.log(entry);
  }
}

/**
 * Create a request-scoped logger with a unique ID.
 * All calls from the same logger share a requestId for correlation.
 */
export type RequestLogger = (event: string, data?: Record<string, unknown>) => void;

export function createRequestLogger(): RequestLogger {
  const requestId = Math.random().toString(36).slice(2, 10);
  return (event: string, data?: Record<string, unknown>) => {
    log(event, { requestId, ...data });
  };
}

/**
 * Emit a final `turn_end` log event and yield the Node event loop so
 * stdout drains before Vercel hibernates the function container.
 *
 * Fix for #90: logs emitted from inside Next.js `after()` callbacks were
 * being dropped in prod. The primary `mention_start` log (sync path)
 * reaches Vercel's log drain fine; all subsequent events inside the
 * async `after()` body (agent_start, agent_tool_call, agent_complete,
 * cache metrics, answer_posted…) disappeared. Giving Node one tick via
 * setImmediate lets stdout flush before the container shuts down.
 *
 * Place this as the last statement in every `after()` body — ideally
 * inside a `finally` block so it runs even on errors. The `turn_end`
 * event itself acts as a canary: if it appears in production logs,
 * the flush worked and so did every earlier log in the same turn.
 */
export async function flushLogs(rlog: RequestLogger, flow: string): Promise<void> {
  try {
    rlog("turn_end", { flow });
  } catch {
    // Never let a logging error break the post-response flow.
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
}
