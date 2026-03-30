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

// ── References ────────────────────────────────────────────────────────
export interface Reference {
  label: string; // e.g. "app/Models/User.php" or "Issue #42"
  url: string; // GitHub URL (html_url — includes line anchors for search results)
}

// ── Tool executor ─────────────────────────────────────────────────────
export type ToolResult =
  | { type: "text"; text: string; references?: Reference[] }
  | { type: "issue_proposal"; proposal: IssueProposal; references?: Reference[] };

function issueUrl(number: number): string {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  return `https://github.com/${owner}/${repo}/issues/${number}`;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "search_code": {
      // Returns { text, references } with real GitHub html_urls (include line anchors)
      const result = await executeSearchCode(input);
      return { type: "text", text: result.text, references: result.references };
    }
    case "read_file": {
      // Returns { text, references } with real GitHub html_url for the file
      const result = await executeReadFile(input);
      return { type: "text", text: result.text, references: result.references };
    }
    case "list_issues": {
      const text = await executeListIssues(input);
      const refs: Reference[] = [];
      if (input.issue_number) {
        const num = input.issue_number as number;
        refs.push({ label: `Issue #${num}`, url: issueUrl(num) });
      } else {
        // Extract issue numbers from list output
        const issuePattern = /#(\d+)/g;
        let match;
        while ((match = issuePattern.exec(text)) !== null) {
          const num = parseInt(match[1], 10);
          if (!refs.some((r) => r.label === `#${num}`)) {
            refs.push({ label: `#${num}`, url: issueUrl(num) });
          }
        }
      }
      return { type: "text", text, references: refs };
    }
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
