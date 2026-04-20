import * as Sentry from "@sentry/nextjs";

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

  // [DIAGNOSTIC] Force an Issue in Sentry after init. Issues tab is always
  // on (unlike the Logs feature), so if this shows up we know init worked.
  // Remove once observability is verified end-to-end.
  try {
    Sentry.captureException(
      new Error(
        `bm cold-start canary — runtime=${process.env.NEXT_RUNTIME} commit=${
          process.env.VERCEL_GIT_COMMIT_SHA ?? "local"
        }`,
      ),
    );
    await Sentry.flush(2000);
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event: "instrumentation_canary_flushed",
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

export const onRequestError = Sentry.captureRequestError;
