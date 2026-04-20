/**
 * Structured Logger — JSON output for Vercel function logs + Sentry Logs UI.
 *
 * Every entry is a single JSON line via console.log/error with:
 * - event: string — what happened
 * - ts: number — unix timestamp
 * - requestId: string — correlates all events in one invocation
 * - ...data: additional context
 *
 * Single sink: stdout/stderr. Sentry's consoleLoggingIntegration
 * (wired in sentry.server.config.ts) captures every console.* call and
 * ships it to Sentry's Logs UI. Sentry's SDK internally calls
 * `vercelWaitUntil(Sentry.flush())` so events emitted from inside
 * `after()` callbacks arrive reliably despite Vercel's stdout drop.
 *
 * When SENTRY_DSN is unset the integration is a silent no-op and
 * logs only reach Vercel's drain — which works fine locally and in CI.
 */

export function log(event: string, data?: Record<string, unknown>): void {
  const payload = { event, ...data, ts: Date.now() };
  const entry = JSON.stringify(payload);
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
