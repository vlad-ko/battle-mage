// This file configures the initialization of Sentry for edge features
// (middleware, edge routes). Loaded from src/instrumentation.ts when
// NEXT_RUNTIME === "edge".
// Note: this config is unrelated to Vercel Edge Runtime and is required
// when running locally too.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

// Mirrors the server config's guard: non-numeric env becomes NaN and
// would give the SDK undefined sampling behavior. See the long comment
// in sentry.server.config.ts for why.
function parseTracesSampleRate(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

Sentry.init({
  dsn:
    process.env.SENTRY_DSN ??
    "https://ddaed8e7978f25625da4418ccb2633c5@o26192.ingest.us.sentry.io/4511249153851392",

  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,

  tracesSampleRate: parseTracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),

  enableLogs: true,

  // Off — same rationale as server config.
  sendDefaultPii: false,
});
