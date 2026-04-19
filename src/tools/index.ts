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
// Anthropic caches every block up through the one marked with cache_control.
// Marking only the LAST tool caches the entire tools array as one chunk.
export const tools: Tool[] = [
  searchCodeTool,
  readFileTool,
  listIssuesTool,
  listCommitsTool,
  listPRsTool,
  createIssueTool,
  { ...saveKnowledgeTool, cache_control: { type: "ephemeral" } },
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
      // Only generate refs for single-issue lookups, not bulk lists.
      // Bulk list results are discovery aids — the agent cites specific
      // items in its answer text, and rankReferences boosts those.
      if (input.issue_number) {
        const num = input.issue_number as number;
        const titleMatch = result.match(/\*\*#\d+:\s*(.+?)\*\*/);
        const title = titleMatch ? titleMatch[1] : `Issue #${num}`;
        refs.push({ label: `#${num} ${title}`, url: issueUrl(num), type: "issue" });
      }
      return { type: "text", text: result, references: refs };
    }
    case "list_commits": {
      // Bulk list — no refs. The agent's answer text cites specific items.
      const result = await executeListCommits(input);
      return { type: "text", text: result, references: [] };
    }
    case "list_prs": {
      // Bulk list — no refs.
      const result = await executeListPRs(input);
      return { type: "text", text: result, references: [] };
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
