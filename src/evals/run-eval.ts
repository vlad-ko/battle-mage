import { runAgent, type AgentResult } from "@/lib/claude";
import type { LogFn } from "@/lib/logger";

function requireEnv(name: string): void {
  if (!process.env[name]) {
    throw new Error(
      `${name} is required to run evals. Evals call real Anthropic + GitHub APIs. ` +
        `Set it in your shell before 'npm run eval'.`,
    );
  }
}

// Drops all structured log events so eval runs don't pollute vitest output
// with per-round agent JSON. Override by setting EVAL_VERBOSE=1 in the
// environment when debugging a failing eval.
const silentLog: LogFn =
  process.env.EVAL_VERBOSE
    ? (event, data) => {
        // eslint-disable-next-line no-console
        console.log(`[eval] ${event}`, data ?? "");
      }
    : () => {};

// Runs runAgent() against the real Anthropic + GitHub APIs with no-op
// callbacks and a silent logger (see EVAL_VERBOSE above), so fixtures
// only see the final AgentResult. Intentionally minimal — each fixture
// composes its own rubric assertions on the returned result.
export async function runEval(question: string): Promise<AgentResult> {
  requireEnv("ANTHROPIC_API_KEY");
  requireEnv("GITHUB_PAT_BM");
  requireEnv("GITHUB_OWNER");
  requireEnv("GITHUB_REPO");

  return runAgent(
    question,
    undefined, // conversationHistory: none
    silentLog, // rlog: suppresses agent_start / agent_complete / agent_tool_call / ...
  );
}
