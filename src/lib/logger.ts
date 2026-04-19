/**
 * Structured Logger — JSON output for Vercel function logs + Sentry events.
 *
 * All log entries are JSON objects with:
 * - event: string — what happened
 * - ts: number — unix timestamp
 * - requestId: string — correlates all events in one invocation
 * - ...data: additional context
 *
 * Two sinks:
 * 1. Stdout/stderr via console.log/error — visible in `vercel logs` CLI and
 *    Vercel Dashboard > Project > Logs. Drops writes from inside `after()`
 *    callbacks on Vercel (see #90) so this sink alone is unreliable.
 * 2. Sentry.logger.info/error — first-class Sentry log events. Sentry's
 *    Next.js SDK uses `vercelWaitUntil(Sentry.flush())` so `after()` events
 *    arrive reliably. When SENTRY_DSN is unset, the SDK is a silent no-op
 *    and this degrades to sink (1) only.
 */
import * as Sentry from "@sentry/nextjs";

export function log(event: string, data?: Record<string, unknown>): void {
  const payload = { event, ...data, ts: Date.now() };
  const entry = JSON.stringify(payload);
  const isError = event.includes("error");
  if (isError) {
    console.error(entry);
  } else {
    console.log(entry);
  }
  // Dual-emit to Sentry so events survive Vercel's `after()` stdout drop.
  // Wrapped defensively — a logging side-effect must never break the
  // request flow. `Sentry.logger` is the v10 first-class log API.
  try {
    if (Sentry.logger) {
      if (isError) {
        Sentry.logger.error(event, payload);
      } else {
        Sentry.logger.info(event, payload);
      }
    }
  } catch {
    // Swallow — Sentry unavailable / misconfigured / SDK changed.
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
