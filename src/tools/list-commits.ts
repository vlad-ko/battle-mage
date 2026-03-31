import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { listRecentCommits } from "@/lib/github";

export const listCommitsTool: Tool = {
  name: "list_commits",
  description:
    "List recent commits on the main branch, newest first. Use this to understand what work has been done recently — especially useful for 'what's new' or 'recent changes' questions.",
  input_schema: {
    type: "object" as const,
    properties: {
      count: {
        type: "number",
        description: "Number of recent commits to return. Defaults to 10.",
      },
    },
    required: [],
  },
};

export async function executeListCommits(
  input: Record<string, unknown>,
): Promise<string> {
  const count = (input.count as number) || 10;
  const commits = await listRecentCommits(count);

  if (commits.length === 0) {
    return "No recent commits found.";
  }

  return commits
    .map((c) => `- \`${c.sha}\` (${c.date}) ${c.message}`)
    .join("\n");
}
