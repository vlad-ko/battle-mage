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
  console.log(JSON.stringify({ event, ...data, ts: Date.now() }));
}

/**
 * Create a request-scoped logger with a unique ID.
 * All calls from the same logger share a requestId for correlation.
 */
export function createRequestLogger(): (event: string, data?: Record<string, unknown>) => void {
  const requestId = Math.random().toString(36).slice(2, 10);
  return (event: string, data?: Record<string, unknown>) => {
    log(event, { requestId, ...data });
  };
}
