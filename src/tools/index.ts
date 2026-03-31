import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { searchCodeTool, executeSearchCode } from "./search-code";
import { readFileTool, executeReadFile } from "./read-file";
import { listIssuesTool, executeListIssues } from "./list-issues";
import { createIssueTool, extractIssueProposal } from "./create-issue";
import type { IssueProposal } from "./create-issue";
import { saveKnowledgeTool, executeSaveKnowledge } from "./save-knowledge";
import { listCommitsTool, executeListCommits } from "./list-commits";
import { listPRsTool, executeListPRs } from "./list-prs";

// ── Tool registry ─────────────────────────────────────────────────────
export const tools: Tool[] = [
  searchCodeTool,
  readFileTool,
  listIssuesTool,
  listCommitsTool,
  listPRsTool,
  createIssueTool,
  saveKnowledgeTool,
];

// ── References ────────────────────────────────────────────────────────
export interface Reference {
  label: string; // e.g. "src/auth.ts" or "#42 Fix login bug"
  url: string; // GitHub URL
  type: "issue" | "pr" | "commit" | "file" | "doc";
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
      const result = await executeListIssues(input);
      const refs: Reference[] = [];
      if (input.issue_number) {
        const num = input.issue_number as number;
        // Extract title from the result text (first line has "**#N: Title**")
        const titleMatch = result.match(/\*\*#\d+:\s*(.+?)\*\*/);
        const title = titleMatch ? titleMatch[1] : `Issue #${num}`;
        refs.push({ label: `#${num} ${title}`, url: issueUrl(num), type: "issue" });
      } else {
        // Extract issue numbers and titles from list output
        const issuePattern = /\*\*#(\d+)\*\*:\s*(.+?)\s*\(/g;
        let match;
        while ((match = issuePattern.exec(result)) !== null) {
          const num = parseInt(match[1], 10);
          const title = match[2].trim();
          if (!refs.some((r) => r.label.startsWith(`#${num}`))) {
            refs.push({ label: `#${num} ${title}`, url: issueUrl(num), type: "issue" });
          }
        }
      }
      return { type: "text", text: result, references: refs };
    }
    case "list_commits": {
      const result = await executeListCommits(input);
      const refs: Reference[] = [];
      const commitPattern = /`([a-f0-9]{7})`\s+\(\d{4}-\d{2}-\d{2}\)\s+(.+)/g;
      let match;
      while ((match = commitPattern.exec(result)) !== null) {
        const sha = match[1];
        const msg = match[2].slice(0, 60);
        refs.push({
          label: `${sha} ${msg}`,
          url: `https://github.com/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/commit/${sha}`,
          type: "commit",
        });
      }
      return { type: "text", text: result, references: refs };
    }
    case "list_prs": {
      const result = await executeListPRs(input);
      const refs: Reference[] = [];
      const prPattern = /\*\*#(\d+)\*\*:\s*(.+?)\s*\(/g;
      let match;
      while ((match = prPattern.exec(result)) !== null) {
        const num = parseInt(match[1], 10);
        const title = match[2].trim();
        refs.push({
          label: `#${num} ${title}`,
          url: `https://github.com/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/pull/${num}`,
          type: "pr",
        });
      }
      return { type: "text", text: result, references: refs };
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
