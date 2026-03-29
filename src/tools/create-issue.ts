import type { Tool } from "@anthropic-ai/sdk/resources/messages";

// NOTE: This tool only PROPOSES an issue. Actual creation is gated behind
// explicit Slack confirmation from the requesting user (see route.ts).

export const createIssueTool: Tool = {
  name: "create_issue",
  description:
    "Propose a new GitHub issue. This does NOT create the issue immediately — it drafts a proposal that the user must explicitly confirm in Slack before it is created. Use this when a user asks you to file a bug, feature request, or task.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: {
        type: "string",
        description: "Issue title — concise and descriptive",
      },
      body: {
        type: "string",
        description:
          "Issue body in Markdown — include context, steps to reproduce (for bugs), or acceptance criteria (for features)",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional labels to apply, e.g. ['bug', 'high-priority']",
      },
    },
    required: ["title", "body"],
  },
};

export interface IssueProposal {
  title: string;
  body: string;
  labels?: string[];
}

export function extractIssueProposal(
  input: Record<string, unknown>,
): IssueProposal {
  return {
    title: input.title as string,
    body: input.body as string,
    labels: input.labels as string[] | undefined,
  };
}
