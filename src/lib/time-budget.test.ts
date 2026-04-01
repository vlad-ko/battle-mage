import { describe, it, expect } from "vitest";
import {
  shouldWarnBudget,
  shouldForceStop,
  AGENT_BUDGET_MS,
  AGENT_WARN_THRESHOLD,
} from "./time-budget";

describe("time-budget", () => {
  it("AGENT_BUDGET_MS is 5 minutes", () => {
    expect(AGENT_BUDGET_MS).toBe(5 * 60 * 1000);
  });

  it("AGENT_WARN_THRESHOLD is 0.8 (80%)", () => {
    expect(AGENT_WARN_THRESHOLD).toBe(0.8);
  });

  describe("shouldWarnBudget", () => {
    it("returns false when under 80% of budget", () => {
      const start = Date.now() - 60_000; // 1 minute elapsed
      expect(shouldWarnBudget(start)).toBe(false);
    });

    it("returns true when over 80% of budget", () => {
      const start = Date.now() - 250_000; // 4m10s elapsed (> 80% of 5m)
      expect(shouldWarnBudget(start)).toBe(true);
    });

    it("returns true at exactly 80%", () => {
      const start = Date.now() - (AGENT_BUDGET_MS * AGENT_WARN_THRESHOLD);
      expect(shouldWarnBudget(start)).toBe(true);
    });
  });

  describe("shouldForceStop", () => {
    it("returns false when under budget", () => {
      const start = Date.now() - 60_000; // 1 minute elapsed
      expect(shouldForceStop(start)).toBe(false);
    });

    it("returns true when over budget", () => {
      const start = Date.now() - 310_000; // 5m10s elapsed
      expect(shouldForceStop(start)).toBe(true);
    });

    it("returns true at exactly budget", () => {
      const start = Date.now() - AGENT_BUDGET_MS;
      expect(shouldForceStop(start)).toBe(true);
    });
  });
});
