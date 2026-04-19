// This file configures the initialization of Sentry on the server.
// Loaded from src/instrumentation.ts on the Node runtime.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
//
// Why Sentry and not just console.log?
// Logs emitted from inside Next.js `after()` callbacks are dropped by
// Vercel's log drain before they reach stdout — a known serverless
// quirk tracked in #90. Sentry's Next.js SDK internally calls
// `vercelWaitUntil(Sentry.flush())` to keep the function alive until
// events are transmitted, so after() events land reliably. Same
// approach getsentry/junior uses on the same stack.
//
// When SENTRY_DSN is unset the SDK falls back to the hardcoded public
// DSN below (which is safe — it's already in every client bundle).

import * as Sentry from "@sentry/nextjs";

// Parse SENTRY_TRACES_SAMPLE_RATE defensively. Non-numeric values
// (e.g. env var accidentally set to "true" or "full") would otherwise
// become NaN and give Sentry undefined sampling behavior. Clamp to
// [0, 1] and fall back to 1 (full sampling) on invalid input so a
// misconfigured env never silently disables tracing.
function parseTracesSampleRate(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

Sentry.init({
  // Public DSN — appears in client bundles regardless. Hardcoded per the
  // Sentry wizard's canonical pattern. SENTRY_DSN env var overrides.
  dsn:
    process.env.SENTRY_DSN ??
    "https://ddaed8e7978f25625da4418ccb2633c5@o26192.ingest.us.sentry.io/4511249153851392",

  // Tag events with the environment they came from.
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  // Vercel sets VERCEL_GIT_COMMIT_SHA on every build — releases correlate
  // with deploys automatically.
  release: process.env.VERCEL_GIT_COMMIT_SHA,

  // Full sampling by default; override with SENTRY_TRACES_SAMPLE_RATE.
  tracesSampleRate: parseTracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),

  // v10 first-class log events. Pairs with Sentry.logger.info() calls
  // from src/lib/logger.ts so structured events reach Sentry.io instead
  // of (or in addition to) stdout.
  enableLogs: true,

  // Off by default — we don't need IP/User-Agent. Events come from Slack
  // webhooks where the IP is Slack's and carries no debugging value.
  sendDefaultPii: false,

  integrations: [
    // Auto-instruments Vercel AI SDK calls with `gen_ai.*` semantic-
    // convention spans. Mostly dormant — we use the bare Anthropic SDK
    // today — but free once we migrate per #81.
    Sentry.vercelAIIntegration({
      recordInputs: true,
      recordOutputs: true,
    }),
  ],
});
