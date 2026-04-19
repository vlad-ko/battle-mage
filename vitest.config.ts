import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    // Eval fixtures use the standard .test.ts suffix (per CLAUDE.md rule)
    // but hit real APIs and cost money — they run ONLY via `npm run eval`
    // under vitest.evals.config.ts, never under the default `npm test`.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "src/evals/fixtures/**",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
