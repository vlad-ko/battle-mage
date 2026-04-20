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
    "https://df0990271471b52befc34026b304b57d@o4510931548831744.ingest.us.sentry.io/4511254221619200",

  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,

  tracesSampleRate: parseTracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),

  enableLogs: true,

  // Off — same rationale as server config.
  sendDefaultPii: false,

  integrations: [
    // Mirrors server config — capture console.* as Sentry Logs on the
    // edge runtime too. The Slack webhook lands on nodejs today, but
    // middleware and future edge routes would otherwise lose logs.
    Sentry.consoleLoggingIntegration({ levels: ["log", "warn", "error"] }),
  ],
});
