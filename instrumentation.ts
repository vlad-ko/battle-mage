// Next.js runtime-selection entry point for instrumentation.
// Called ONCE per worker before any request handler runs.
//
// See sentry.server.config.ts for why Sentry (short version: it's the
// only thing that reliably captures logs from `after()` on Vercel, per
// #90).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
}

// Wires Next.js's built-in request-error capture into Sentry so 500s
// and uncaught exceptions in server components / route handlers are
// reported automatically with stack traces.
export { captureRequestError as onRequestError } from "@sentry/nextjs";
