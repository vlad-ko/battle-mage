import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { listRecentPRs } from "@/lib/github";

export const listPRsTool: Tool = {
  name: "list_prs",
  description:
    "List recent pull requests, newest first. Shows open, merged, and closed PRs. Use this to understand what features and fixes have been shipped or are in progress.",
  input_schema: {
    type: "object" as const,
    properties: {
      state: {
        type: "string",
        enum: ["open", "closed", "all"],
        description: "Filter by PR state. Defaults to 'all'.",
      },
      count: {
        type: "number",
        description: "Number of recent PRs to return. Defaults to 10.",
      },
    },
    required: [],
  },
};

export async function executeListPRs(
  input: Record<string, unknown>,
): Promise<string> {
  const state = (input.state as "open" | "closed" | "all") || "all";
  const count = (input.count as number) || 10;
  const prs = await listRecentPRs(state, count);

  if (prs.length === 0) {
    return `No ${state} PRs found.`;
  }

  return prs
    .map((pr) => {
      const status = pr.merged ? "merged" : pr.state;
      return `- **#${pr.number}**: ${pr.title} (${status}, updated: ${pr.updated_at})`;
    })
    .join("\n");
}
