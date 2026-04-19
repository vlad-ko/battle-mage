// Sentry initialization for the Node runtime. Loaded from instrumentation.ts.
//
// Why Sentry and not just console.log?
// Logs emitted from inside Next.js `after()` callbacks are dropped by
// Vercel's log drain before they reach stdout — a known serverless
// quirk tracked in #90. Sentry's Next.js SDK internally calls
// `vercelWaitUntil(Sentry.flush())` to keep the function alive until
// events are transmitted, so after() events land reliably. Same
// approach junior (getsentry/junior) uses.
//
// When SENTRY_DSN is not set (local dev, CI, tests), the SDK is a
// silent no-op — no events sent, no network traffic.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  // Tag events with the environment they came from. Vercel sets
  // VERCEL_ENV = "production" | "preview" | "development" automatically.
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  // Vercel sets VERCEL_GIT_COMMIT_SHA on every build, so releases
  // correlate with deploys with zero extra configuration.
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  // Full sampling by default — battle-mage volume is low and we want
  // every turn traceable. Override with SENTRY_TRACES_SAMPLE_RATE if
  // volume ever grows enough to need throttling.
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "1"),
  // Disable entirely when no DSN is configured. Important for tests,
  // local dev without Sentry, and CI — avoids accidental event sends.
  enabled: Boolean(process.env.SENTRY_DSN),
  // v10 first-class log events. Pairs with Sentry.logger.info() calls
  // from src/lib/logger.ts so structured events reach Sentry.io instead
  // of (or in addition to) stdout.
  enableLogs: true,
  // Attach Slack user IDs / GitHub repo info when available. Nothing
  // here is PII in the classic sense, but sendDefaultPii = true also
  // captures IP + user-agent on HTTP requests which helps debugging.
  sendDefaultPii: true,
  // Auto-instruments Vercel AI SDK calls with gen_ai.* semantic-
  // convention spans (invoke_agent, execute_tool, etc.). We're on the
  // bare Anthropic SDK, not the Vercel AI SDK, so this is mostly
  // dormant — but leaving it enabled means we get spans for free if
  // we ever migrate.
  integrations: [
    Sentry.vercelAIIntegration({
      recordInputs: true,
      recordOutputs: true,
    }),
  ],
});
