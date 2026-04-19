import { defineConfig } from "vitest/config";
import path from "path";

// Evals hit real Anthropic + GitHub APIs and cost money. They are opt-in
// via `npm run eval` and do NOT run on `npm test`. Pattern tests for the
// rubric scorers themselves still live under *.test.ts and run in the
// regular suite.
export default defineConfig({
  test: {
    globals: true,
    include: ["src/evals/fixtures/**/*.test.ts"],
    testTimeout: 5 * 60 * 1000, // agent budget is 5 min per turn
    hookTimeout: 60 * 1000,
    sequence: {
      // Serialize fixtures so parallel API calls don't hit rate limits
      // and so the cost is predictable.
      concurrent: false,
    },
    reporters: ["verbose"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
