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
 * ships it to Sentry's Logs UI.
 *
 * ### Tail-drop fix (#98)
 *
 * @sentry/nextjs auto-flushes via `vercelWaitUntil(flushSafelyWithTimeout())`
 * at route-handler response time — which fires BEFORE Next.js's
 * `after()` callbacks run. Any log emitted inside `after()` lands in
 * the Sentry buffer AFTER the auto-flush has already fired, and relies
 * on the 5-second weight-timer for its next drain — which Vercel may
 * not give us before freezing the container. Result: the tail of long
 * `after()` blocks (the `agent_complete` / `turn_end` / feedback
 * events) would drop at ~12% of mention flows.
 *
 * `flushLogs()` below explicitly calls `Sentry.flush(2000)` after the
 * final `turn_end` event so the buffer drains before the serverless
 * function container hibernates. This matches the SDK's own
 * `flushSafelyWithTimeout` pattern.
 *
 * Note: `sentry.server.config.ts` falls back to a hardcoded public DSN
 * when `SENTRY_DSN` is unset, so telemetry is ALWAYS shipped to Sentry
 * when running code built from this repo. To truly disable Sentry,
 * remove the hardcoded fallback (or comment out `Sentry.init`). In
 * local dev / CI with no network path to sentry.io the SDK's transport
 * silently fails and logs degrade to stdout only.
 */

import * as Sentry from "@sentry/nextjs";

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
 * A plain log function — event name + optional data. Use this as the
 * parameter type anywhere a caller only needs to INVOKE the logger
 * (the overwhelming majority of internal call sites). Accepts both a
 * bare function and a full RequestLogger.
 */
export type LogFn = (event: string, data?: Record<string, unknown>) => void;

/**
 * Request-scoped logger: callable like LogFn, plus exposes the shared
 * `requestId` as a property so surfaces that render it (e.g., the reply
 * footer in #79) can read it without regenerating one. All calls from
 * the same logger share that requestId for correlation.
 */
export type RequestLogger = LogFn & {
  readonly requestId: string;
};

export function createRequestLogger(): RequestLogger {
  const requestId = Math.random().toString(36).slice(2, 10);
  const fn = (event: string, data?: Record<string, unknown>) => {
    log(event, { requestId, ...data });
  };
  // Attach requestId as a readable property on the function object.
  return Object.assign(fn, { requestId });
}

/**
 * Emit a final `turn_end` log event and explicitly drain the Sentry
 * buffer so any logs emitted inside this `after()` body make it off
 * the container before it hibernates.
 *
 * Place this as the last statement in every `after()` body — ideally
 * inside a `finally` block so it runs even on errors. The `turn_end`
 * event itself acts as a canary: if it appears in production logs,
 * the flush worked and so did every earlier log in the same turn.
 *
 * See the file-header comment for the root cause this addresses (#98).
 */
const FLUSH_TIMEOUT_MS = 2000;

export async function flushLogs(rlog: LogFn, flow: string): Promise<void> {
  try {
    rlog("turn_end", { flow });
  } catch {
    // Never let a logging error break the post-response flow.
  }
  try {
    // Matches the SDK's own `flushSafelyWithTimeout` pattern. Drains
    // both console-captured logs and any `Sentry.logger.*` envelopes —
    // they share the same buffer under `_INTERNAL_captureLog`.
    await Sentry.flush(FLUSH_TIMEOUT_MS);
  } catch {
    // A failed flush must not surface as a post-response error. If
    // Sentry is down, the turn has already completed correctly from
    // the user's perspective.
  }
}
