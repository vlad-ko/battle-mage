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

  // [DIAGNOSTIC] One-shot canary that forces an Issue in Sentry after
  // init. If this Issue appears in the dashboard, Sentry.init works and
  // the problem is in our logger's Sentry.logger call path. If it does
  // NOT appear, instrumentation.ts is not being loaded by Next.js.
  //
  // Fire-and-forget — Sentry's transport will drain on function teardown
  // via vercelWaitUntil. Awaiting flush() here would put up to 2s of
  // latency on the cold-start critical path.
  if (!canaryFired) {
    canaryFired = true;
    try {
      Sentry.captureException(
        new Error(
          `bm cold-start canary — runtime=${process.env.NEXT_RUNTIME} commit=${
            process.env.VERCEL_GIT_COMMIT_SHA ?? "local"
          }`,
        ),
      );
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          event: "instrumentation_canary_captured",
          runtime: process.env.NEXT_RUNTIME ?? "unknown",
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
