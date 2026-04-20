// Sentry init for the browser bundle. Captures unhandled errors in
// page components (the landing page in src/app/page.tsx is currently
// the only client-rendered surface).
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

// Mirrors the server/edge configs — keep the NaN guard consistent so a
// malformed env var doesn't silently break client tracing.
function parseTracesSampleRate(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

Sentry.init({
  dsn: "https://df0990271471b52befc34026b304b57d@o4510931548831744.ingest.us.sentry.io/4511254221619200",

  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,

  tracesSampleRate: parseTracesSampleRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE),

  enableLogs: true,

  // Off — battle-mage has no user accounts and no meaningful client UI
  // beyond the static landing page. IP/UA on a marketing page adds no
  // debugging value and quietly sends more data than we need.
  sendDefaultPii: false,

  // Session Replay intentionally NOT enabled — we have no interactive
  // UI to replay (Slack is our product surface). Removing it keeps the
  // client bundle small and avoids sending replay data we won't use.
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
