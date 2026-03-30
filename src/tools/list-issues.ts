import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { listIssues, getIssue } from "@/lib/github";

export const listIssuesTool: Tool = {
  name: "list_issues",
  description:
    "List GitHub issues sorted by most recently updated. Can filter by state and labels. Results include dates so you can assess recency.",
  input_schema: {
    type: "object" as const,
    properties: {
      state: {
        type: "string",
        enum: ["open", "closed", "all"],
        description: "Filter by issue state. Defaults to 'open'.",
      },
      labels: {
        type: "string",
        description:
          "Comma-separated list of label names to filter by, e.g. 'bug,high-priority'",
      },
      issue_number: {
        type: "number",
        description:
          "If provided, fetches a single issue by number instead of listing.",
      },
    },
    required: [],
  },
};

export async function executeListIssues(
  input: Record<string, unknown>,
): Promise<string> {
  // Single issue lookup
  if (input.issue_number) {
    const issue = await getIssue(input.issue_number as number);
    return [
      `**#${issue.number}: ${issue.title}** (${issue.state})`,
      issue.url,
      "",
      issue.body || "_No description_",
    ].join("\n");
  }

  // List issues
  const state = (input.state as "open" | "closed" | "all") || "open";
  const labels = input.labels as string | undefined;
  const issues = await listIssues(state, labels);

  if (issues.length === 0) {
    return `No ${state} issues found${labels ? ` with labels: ${labels}` : ""}.`;
  }

  return issues
    .map((i) => {
      const updated = i.updated_at ? ` (updated: ${i.updated_at.split("T")[0]})` : "";
      const labels = i.labels.length ? ` [${i.labels.join(", ")}]` : "";
      return `- **#${i.number}**: ${i.title} (${i.state})${updated}${labels}`;
    })
    .join("\n");
}
