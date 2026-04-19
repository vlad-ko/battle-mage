import { runAgent, type AgentResult } from "@/lib/claude";

function requireEnv(name: string): void {
  if (!process.env[name]) {
    throw new Error(
      `${name} is required to run evals. Evals call real Anthropic + GitHub APIs. ` +
        `Set it in your shell before 'npm run eval'.`,
    );
  }
}

// Runs runAgent() against the real Anthropic + GitHub APIs with no-op
// progress/delta callbacks and a silent logger, so fixtures only see the
// final AgentResult. Intentionally minimal — each fixture composes its own
// rubric assertions on the returned result.
export async function runEval(question: string): Promise<AgentResult> {
  requireEnv("ANTHROPIC_API_KEY");
  requireEnv("GITHUB_PAT_BM");
  requireEnv("GITHUB_OWNER");
  requireEnv("GITHUB_REPO");

  return runAgent(
    question,
    undefined, // onProgress: no-op
    undefined, // conversationHistory: none
    undefined, // rlog: falls back to bare log, which we silence via console.log no-op below if needed
    undefined, // onTextDelta: no-op
  );
}
