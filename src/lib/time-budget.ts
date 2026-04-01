/**
 * Time Budget — prevents the agent from running indefinitely.
 *
 * Default: 5 minutes (300 seconds).
 * At 80%: warn the agent to synthesize with what it has.
 * At 100%: force-stop the loop and return partial answer.
 */

export const AGENT_BUDGET_MS = 5 * 60 * 1000; // 5 minutes
export const AGENT_WARN_THRESHOLD = 0.8; // 80%

export function shouldWarnBudget(startTime: number): boolean {
  const elapsed = Date.now() - startTime;
  return elapsed >= AGENT_BUDGET_MS * AGENT_WARN_THRESHOLD;
}

export function shouldForceStop(startTime: number): boolean {
  const elapsed = Date.now() - startTime;
  return elapsed >= AGENT_BUDGET_MS;
}
