import { defineConfig } from "vitest/config";
import path from "path";

// Behavior evals (#137): full-turn scenarios replayed against committed
// cassettes. Keyless and deterministic by default (`npm run eval:behavior`);
// RECORD=1 re-records against live Anthropic/GitHub (local only — the
// harness refuses to record under CI, invariant I7).
//
// The harness unit tests (src/evals/behavior/harness/*.test.ts) run under
// the regular `npm test`; only the scenarios live here.
export default defineConfig({
  test: {
    globals: true,
    include: ["src/evals/behavior/scenarios/**/*.test.ts"],
    // Scenarios share module-registry-level mock wiring (vi.doMock +
    // vi.resetModules per scenario) — never run files in parallel.
    fileParallelism: false,
    sequence: { concurrent: false },
    // Replay is fast (<30s covers the whole suite with margin); recording
    // makes real agent turns and needs the full per-turn budget.
    testTimeout: process.env.RECORD === "1" ? 300_000 : 30_000,
    hookTimeout: 60_000,
    reporters: ["verbose"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
