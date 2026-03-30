import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { searchCodeTool, executeSearchCode } from "./search-code";
import { readFileTool, executeReadFile } from "./read-file";
import { listIssuesTool, executeListIssues } from "./list-issues";
import { createIssueTool, extractIssueProposal } from "./create-issue";
import type { IssueProposal } from "./create-issue";
import { saveKnowledgeTool, executeSaveKnowledge } from "./save-knowledge";

// ── Tool registry ─────────────────────────────────────────────────────
export const tools: Tool[] = [
  searchCodeTool,
  readFileTool,
  listIssuesTool,
  createIssueTool,
  saveKnowledgeTool,
];

// ── Tool executor ─────────────────────────────────────────────────────
export type ToolResult =
  | { type: "text"; text: string }
  | { type: "issue_proposal"; proposal: IssueProposal };

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "search_code":
      return { type: "text", text: await executeSearchCode(input) };
    case "read_file":
      return { type: "text", text: await executeReadFile(input) };
    case "list_issues":
      return { type: "text", text: await executeListIssues(input) };
    case "create_issue":
      return {
        type: "issue_proposal",
        proposal: extractIssueProposal(input),
      };
    case "save_knowledge":
      return { type: "text", text: await executeSaveKnowledge(input) };
    default:
      return { type: "text", text: `Unknown tool: ${name}` };
  }
}
