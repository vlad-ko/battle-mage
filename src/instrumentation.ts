import * as Sentry from "@sentry/nextjs";

// Module-level single-fire flag: ensures the diagnostic canary emits at
// most ONE Issue per container lifetime, not one per register() call or
// per request. A long-lived serverless container might handle thousands
// of requests; spamming Sentry would pollute the dashboard and burn
// event quota. One Issue per cold-start container is enough to tell us
// whether Sentry.init is working.
let canaryFired = false;

export async function register() {
  // [DIAGNOSTIC] Prove whether Next.js is loading this file at runtime.
  // If this line doesn't show in Vercel logs, instrumentation.ts is not
  // being picked up and Sentry.init never runs — see #90 investigation.
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: "instrumentation_register_start",
      runtime: process.env.NEXT_RUNTIME ?? "unknown",
      ts: Date.now(),
    }),
  );

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }

  // [DIAGNOSTIC] One-shot canaries exercising all three Sentry paths.
  // PR #95 proved Sentry.captureException lands (events ✓) but explicit
  // Sentry.logger.info() calls from our logger.ts produce nothing in the
  // Logs UI. This pass adds two more canaries to isolate which path is
  // actually broken:
  //   1. captureException — baseline, already known working
  //   2. Sentry.logger.info — explicit v10 Logs API; should land if
  //      enableLogs is respected and the SDK isn't silently bailing
  //   3. plain console.log — lands in Sentry only if the paired
  //      consoleLoggingIntegration (see sentry.server.config.ts) is
  //      picking up stdout
  //
  // After deploy + one cold-start, the truth table tells us:
  //   2 lands + 3 lands → both paths healthy; logger.ts bug
  //   2 missing + 3 lands → Sentry.logger.* broken; adopt console path
  //   2 lands + 3 missing → console integration misconfigured
  //   both missing → org-level Logs feature not enabled on sentry.io
  //
  // Fire-and-forget — Sentry's transport will drain on function teardown
  // via vercelWaitUntil. Awaiting flush() here would put up to 2s of
  // latency on the cold-start critical path.
  if (!canaryFired) {
    canaryFired = true;
    const runtime = process.env.NEXT_RUNTIME ?? "unknown";
    const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? "local";
    try {
      Sentry.captureException(
        new Error(`bm cold-start canary — runtime=${runtime} commit=${commit}`),
      );
      // Explicit v10 Logs API — same call shape logger.ts uses on every
      // log(). If this one doesn't land, logger.ts never will.
      Sentry.logger.info("bm_cold_start_logs_canary", {
        path: "sentry.logger.info",
        runtime,
        commit,
      });
      // Plain console.log — captured only if consoleLoggingIntegration
      // is wired. Distinctive event name makes it grep-able in both
      // Vercel logs AND (if integration works) Sentry Logs UI.
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          event: "bm_cold_start_console_canary",
          path: "console.log",
          runtime,
          commit,
          ts: Date.now(),
        }),
      );
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          event: "instrumentation_canary_captured",
          runtime,
          ts: Date.now(),
        }),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          event: "instrumentation_canary_error",
          message: err instanceof Error ? err.message : String(err),
          ts: Date.now(),
        }),
      );
    }
  }
}

export const onRequestError = Sentry.captureRequestError;
