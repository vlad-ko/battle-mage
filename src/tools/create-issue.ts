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

// ── Parse a proposal from the bot's own Slack message text ────────────
// The bot posts proposals in a known format (see route.ts). This parses
// the title, labels, and body back out so we can create the issue when
// the user confirms via ✅ reaction.

const PROPOSAL_TITLE_RE = /\*Proposed Issue:\*\s*(.+)/;
const PROPOSAL_LABELS_RE = /\*Labels:\*\s*(.+)/;
const PROPOSAL_CONFIRM_LINE = "React with :white_check_mark: to create this issue";

export function parseProposalFromMessage(
  text: string,
): IssueProposal | null {
  const titleMatch = text.match(PROPOSAL_TITLE_RE);
  if (!titleMatch) return null;

  const title = titleMatch[1].trim();

  const labelsMatch = text.match(PROPOSAL_LABELS_RE);
  const labels = labelsMatch
    ? labelsMatch[1].split(",").map((l) => l.trim()).filter(Boolean)
    : undefined;

  // Body sits between the labels/title line and the confirmation prompt
  const anchorLine = labelsMatch ? labelsMatch[0] : titleMatch[0];
  const bodyStart = text.indexOf(anchorLine) + anchorLine.length;
  const bodyEnd = text.lastIndexOf(PROPOSAL_CONFIRM_LINE);

  if (bodyEnd === -1) return null;

  const body = text.slice(bodyStart, bodyEnd).trim();
  if (!body) return null;

  return { title, body, labels };
}
