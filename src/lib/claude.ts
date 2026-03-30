import Anthropic from "@anthropic-ai/sdk";
import { tools, executeTool, type ToolResult } from "@/tools";
import type { IssueProposal } from "@/tools/create-issue";
import { readFile } from "@/lib/github";
import { getKnowledgeAsMarkdown } from "@/lib/knowledge";

// ── Anthropic client ──────────────────────────────────────────────────
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOOL_ROUNDS = 10;

// ── Fetch context files from target repo (cached per cold start) ─────
let cachedClaudeMd: string | null | undefined;
// cachedKnowledge removed — now served by Vercel KV via @/lib/knowledge

async function fetchRepoFile(path: string): Promise<string | null> {
  try {
    const result = await readFile(path);
    if ("content" in result && typeof result.content === "string") {
      return result.content;
    }
    return null;
  } catch {
    return null;
  }
}

async function getClaudeMd(): Promise<string | null> {
  if (cachedClaudeMd !== undefined) return cachedClaudeMd;
  cachedClaudeMd = await fetchRepoFile("CLAUDE.md");
  return cachedClaudeMd;
}

async function getKnowledge(): Promise<string | null> {
  // Served by Vercel KV — no GitHub write access needed
  return getKnowledgeAsMarkdown();
}

// ── System prompt ─────────────────────────────────────────────────────
async function buildSystemPrompt(): Promise<string> {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;

  const claudeMd = await getClaudeMd();
  const knowledge = await getKnowledge();
  const contextSection = claudeMd
    ? `\n## Project Context (from CLAUDE.md)\n\n${claudeMd}\n`
    : "";
  const knowledgeSection = knowledge
    ? `\n## Knowledge Base (learned corrections)\n\nThese are facts you learned from prior conversations. Trust these over your own assumptions — they are corrections from the team.\n\n${knowledge}\n`
    : "";

  return `You are Battle Mage (@bm), an AI assistant embedded in Slack with read access to the ${owner}/${repo} GitHub repository.

## Core Principles

1. **Verify before asserting** — Always use your tools to check that files, methods, and classes actually exist before referencing them. Never hallucinate code references.
2. **Cite specifically** — When referencing code, include the file path and line numbers. Link to GitHub when possible.
3. **Thread-only** — You are responding in a Slack thread. Keep answers concise but thorough.
4. **Issue creation requires confirmation** — If asked to create a GitHub issue, propose it with title, body, and labels. The user must explicitly confirm before it is created.

## Available Tools

You have access to these GitHub tools:
- **search_code**: Search for code patterns, function names, classes across the repo
- **read_file**: Read file contents or list directory entries
- **list_issues**: List or look up GitHub issues
- **create_issue**: Propose a new GitHub issue (requires user confirmation)
- **save_knowledge**: Save a correction or fact to the persistent knowledge base

## Knowledge Base — IMPORTANT

You have a persistent knowledge base stored in Vercel KV (not in the GitHub repo). Use it as follows:

*When to save:*
- A user corrects you ("no, that's in app/Services not app/Http")
- A user shares non-obvious insider knowledge ("we deprecated that endpoint last week")
- You discover something surprising that contradicts the codebase docs
- A user says "remember this" or similar

*How to save:*
- Use the \`save_knowledge\` tool immediately when corrected — don't wait
- Write entries as standalone facts, not conversation snippets
- Be specific: include file paths, class names, version numbers
- Good: "The auth module is in app/Services/Auth, not app/Http/Auth"
- Bad: "User said auth is somewhere else"

*When reading:*
- Your knowledge base is loaded into this prompt. Trust it over your own assumptions.
- If a knowledge entry conflicts with what you see in the code, the code is authoritative — but flag the discrepancy.

## Response Style — CRITICAL

You are writing for Slack mrkdwn, NOT standard Markdown. Slack will show raw characters if you use GitHub-style markdown. Follow these rules strictly:

- Bold: *text* (single asterisk, NOT double **)
- Italic: _text_ (underscore)
- Code: \`text\` (backtick)
- Code blocks: \`\`\`text\`\`\` (triple backtick)
- Links: <url|text>
- Lists: use "- " or "• "
- NEVER use # or ## or ### for headings — Slack does not support them. Use *bold text* on its own line instead.
- NEVER use **double asterisks** — Slack renders them literally as **text**
- Be direct and technical — this is an engineering team
- Keep responses concise. Avoid long preambles.
- When answering code questions, show the relevant snippet
- If you're unsure, say so and suggest where to look

## Repository Context

Owner: ${owner}
Repository: ${repo}
${contextSection}${knowledgeSection}`;
}

// ── Agent loop: message → tool calls → final answer ───────────────────

export interface AgentResult {
  text: string;
  issueProposal?: IssueProposal;
}

export async function runAgent(userMessage: string): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let issueProposal: IssueProposal | undefined;
  const systemPrompt = await buildSystemPrompt();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    // If the response has no tool use, extract text and return
    if (response.stop_reason === "end_turn") {
      const textBlocks = response.content.filter(
        (b) => b.type === "text",
      );
      const text = textBlocks.map((b) => {
        if (b.type === "text") return b.text;
        return "";
      }).join("\n");
      return { text, issueProposal };
    }

    // Process tool calls
    const toolUseBlocks = response.content.filter(
      (b) => b.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      // No tool use, no end_turn — extract whatever text we have
      const textBlocks = response.content.filter((b) => b.type === "text");
      const text = textBlocks.map((b) => {
        if (b.type === "text") return b.text;
        return "";
      }).join("\n");
      return { text: text || "I wasn't able to process that request.", issueProposal };
    }

    // Add assistant message with all content blocks
    messages.push({ role: "assistant", content: response.content });

    // Execute each tool and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      if (block.type !== "tool_use") continue;

      try {
        const result: ToolResult = await executeTool(
          block.name,
          block.input as Record<string, unknown>,
        );

        if (result.type === "issue_proposal") {
          issueProposal = result.proposal;
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Issue proposed: "${result.proposal.title}". Awaiting user confirmation in Slack before creation.`,
          });
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.text,
          });
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error";
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: ${errorMessage}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  return {
    text: "I hit the maximum number of tool calls for this request. Here's what I found so far — please ask a more specific question if you need more detail.",
    issueProposal,
  };
}
