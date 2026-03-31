import Anthropic from "@anthropic-ai/sdk";
import { tools, executeTool, type ToolResult, type Reference } from "@/tools";
import type { IssueProposal } from "@/tools/create-issue";
import { readFile } from "@/lib/github";
import { getKnowledgeAsMarkdown } from "@/lib/knowledge";
import { getFeedbackAsMarkdown } from "@/lib/feedback";
import { getOrRebuildIndex, getCachedConfig } from "@/lib/repo-index";
import type { BattleMageConfig } from "@/lib/config";

// ── Anthropic client ──────────────────────────────────────────────────
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const MODEL = "claude-sonnet-4-20250514";
export const MAX_TOOL_ROUNDS = 15;

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

// ── System prompt (pure function — exported for testing) ──────────────

export interface PromptInputs {
  owner: string | undefined;
  repo: string | undefined;
  claudeMd: string | null;
  knowledge: string | null;
  feedback: string | null;
  repoIndex: string | null;
  pathAnnotations: BattleMageConfig | null;
}

function buildAnnotationsSection(config: BattleMageConfig | null): string {
  if (!config || Object.keys(config.paths).length === 0) return "";

  const entries = Object.entries(config.paths);
  const grouped: Record<string, string[]> = {};
  for (const [path, annotation] of entries) {
    if (annotation === "excluded") continue; // Don't tell agent about excluded paths
    if (!grouped[annotation]) grouped[annotation] = [];
    grouped[annotation].push(path);
  }

  if (Object.keys(grouped).length === 0) return "";

  const lines = ["\n## Path Annotations (from .battle-mage.json)\n"];
  lines.push("The team has annotated paths in this repo with trust levels:\n");

  for (const [annotation, paths] of Object.entries(grouped)) {
    lines.push(`- *${annotation}*: ${paths.join(", ")}`);
  }

  lines.push("");
  lines.push("*Rules:*");
  lines.push("- Prefer *core* paths as primary evidence — read these first");
  lines.push("- *current* paths have normal trust — standard behavior");
  lines.push("- Skip *historic* paths unless the question is about history or past decisions. When citing historic content, always qualify as \"historically...\" or \"in the archived docs...\"");
  lines.push("- Skip *vendor* paths unless the question is about dependencies or third-party libraries. When citing vendor code, qualify as third-party");
  lines.push("- Never read or reference excluded paths (they are not shown here)");
  lines.push("");

  return lines.join("\n");
}

export function assembleSystemPrompt(inputs: PromptInputs): string {
  const { owner, repo, claudeMd, knowledge, feedback, repoIndex, pathAnnotations } = inputs;

  const contextSection = claudeMd
    ? `\n## Project Context (from CLAUDE.md)\n\n${claudeMd}\n`
    : "";
  const knowledgeSection = knowledge
    ? `\n## Knowledge Base (learned corrections)\n\nThese are corrections from the team stored in Vercel KV. They can become stale as the codebase evolves — always verify against the actual code before trusting a KB entry.\n\n${knowledge}\n`
    : "";
  const feedbackSection = feedback
    ? `\n## User Feedback (from 👍/👎 reactions)\n\nThis is the weakest, most subjective signal — use it to calibrate tone and style, not as a source of factual truth.\n\n${feedback}\n`
    : "";
  const repoIndexSection = repoIndex
    ? `\n## Repository Map (auto-generated index)\n\nThis map shows the key areas of the repo. Use it to jump directly to relevant files with \`read_file\` instead of searching blind. The map is rebuilt automatically when the repo changes.\n\n${repoIndex}\n`
    : "";
  const annotationsSection = buildAnnotationsSection(pathAnnotations);

  const today = new Date().toISOString().split("T")[0];

  return `You are Battle Mage (@bm), an AI assistant embedded in Slack with read access to the ${owner}/${repo} GitHub repository.

Today's date: ${today}

## Recency and Brevity — CRITICAL

*Recency:*
- Always prefer the most recent activity first. When asked about "recent developments", "status", or "what's new", focus on the last 30 days from today (${today}).
- For "what's new" questions, check MULTIPLE sources of recent activity — not just issues:
  1. \`list_commits\` — shows what code was actually pushed/merged recently
  2. \`list_prs\` — shows features and fixes that shipped or are in progress
  3. \`list_issues\` — shows bugs, feature requests, and their status
  Use all three to build a complete picture. Recent commits and merged PRs are the strongest signals of what's actually happening.
- Files under \`docs/archive/\` or similar archive paths are historical records. Skip them unless the user explicitly asks about history or past decisions.
- If all the information you found is older than 30 days, say so — don't present stale data as current.

*Brevity:*
- Lead with the direct answer in 2-3 sentences.
- Use bullet points for supporting details, not prose paragraphs.
- Target ~15 lines or fewer for a typical answer. Only go longer if the question genuinely requires depth.
- Do NOT editorialize. No brochure-style copy ("What Makes This Special"), no marketing language, no "comprehensive overview" essays. Just answer the question.
- Skip sections like "Development Maturity Indicators" or "Why This Is Impressive" — the user didn't ask for a pitch.
- If the user wants more detail, they'll ask a follow-up.

## Source-of-Truth Hierarchy

When answering questions, you draw from multiple sources. These sources have different reliability levels. When they conflict, prefer higher-ranked sources and flag the discrepancy to the user.

1. *Source code* — The actual implementation. Code is the ultimate source of truth. Always verify claims against the code before asserting them.
2. *Tests* — Encode expected behavior. If tests pass, the tested behavior is correct.
3. *Documentation* (docs/, CLAUDE.md, README) — Describes intent but can drift from reality. If documentation contradicts code, trust the code and flag the stale documentation.
4. *Knowledge base* (Vercel KV corrections) — User corrections from Slack. Useful but can become outdated as code changes. If a KB entry contradicts what you see in the code, the code is authoritative — flag the discrepancy so the team can update the KB.
5. *Feedback signals* (👍/👎 reactions) — The least authoritative signal. Subjective quality preferences. Never treat feedback as factual truth.

*Conflict detection rules:*
- For code-level questions, always read the actual code before asserting anything from docs, KB, or memory.
- When you find a discrepancy between sources, include both the code truth and the stale source in your answer so the user can decide what to update.
- Never silently prefer a lower-ranked source over a higher-ranked one.

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
- **list_commits**: List recent commits on main — newest first, with dates
- **list_prs**: List recent pull requests — shows merged/open status with dates
- **create_issue**: Propose a new GitHub issue (requires user confirmation)
- **save_knowledge**: Save a correction or fact to the persistent knowledge base

## Search Strategy — CRITICAL

You have a maximum of ${MAX_TOOL_ROUNDS} tool rounds per question. Budget them wisely.

*Step 1: Plan* — Before calling any tool, decide what you're looking for. Formulate 1-2 targeted search queries.

*Step 2: Search first, read second* — Always use \`search_code\` before \`read_file\`. A single search returns multiple file paths with context. Don't blindly read files — search to narrow down which files matter.

*Step 3: Read selectively* — Only \`read_file\` for the 2-3 most relevant results from your search. Don't read every match.

*Step 4: Synthesize early* — Start forming your answer after 3-5 tool rounds. Don't exhaust all ${MAX_TOOL_ROUNDS} rounds trying to be exhaustive. A good partial answer is better than hitting the tool limit with no answer.

*Step 5: For broad questions* — If the question is wide-ranging ("what's in our stack?", "how does everything connect?"), give the best answer you can with what you've found, then suggest specific follow-up questions the user can ask to dig deeper into particular areas. Don't try to read the entire codebase.

*Anti-patterns to avoid:*
- Reading files one by one without searching first
- Reading 5+ files in a single question
- Hitting the tool limit without producing an answer
- Trying to give an exhaustive answer to a vague question

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
- Your knowledge base is loaded into this prompt below. It can become stale — always check the code first for code-level questions.
- If a knowledge entry conflicts with what you see in the code, the code is authoritative — flag the discrepancy.

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
${contextSection}${repoIndexSection}${annotationsSection}${knowledgeSection}${feedbackSection}`;
}

// ── Async wrapper that fetches data then assembles ────────────────────
async function buildSystemPrompt(): Promise<string> {
  const repoIndex = await getOrRebuildIndex();
  const config = await getCachedConfig();
  return assembleSystemPrompt({
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    claudeMd: await getClaudeMd(),
    knowledge: await getKnowledge(),
    feedback: await getFeedbackAsMarkdown(),
    repoIndex,
    pathAnnotations: Object.keys(config.paths).length > 0 ? config : null,
  });
}

// ── Agent loop: message → tool calls → final answer ───────────────────

export interface AgentResult {
  text: string;
  issueProposal?: IssueProposal;
  references: Reference[];
}

export type ProgressCallback = (toolName: string, input: Record<string, unknown>) => void | Promise<void>;

export async function runAgent(
  userMessage: string,
  onProgress?: ProgressCallback,
): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let issueProposal: IssueProposal | undefined;
  const allReferences: Reference[] = [];
  const systemPrompt = await buildSystemPrompt();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    // Deduplicate references by URL
    const dedupeRefs = () => {
      const seen = new Set<string>();
      return allReferences.filter((r) => {
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      });
    };

    // If the response has no tool use, extract text and return
    if (response.stop_reason === "end_turn") {
      const textBlocks = response.content.filter(
        (b) => b.type === "text",
      );
      const text = textBlocks.map((b) => {
        if (b.type === "text") return b.text;
        return "";
      }).join("\n");
      return { text, issueProposal, references: dedupeRefs() };
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
      return { text: text || "I wasn't able to process that request.", issueProposal, references: dedupeRefs() };
    }

    // Add assistant message with all content blocks
    messages.push({ role: "assistant", content: response.content });

    // Execute each tool and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      if (block.type !== "tool_use") continue;

      try {
        // Fire progress callback before executing the tool
        if (onProgress) {
          await onProgress(block.name, block.input as Record<string, unknown>);
        }

        const result: ToolResult = await executeTool(
          block.name,
          block.input as Record<string, unknown>,
        );

        // Collect references from tool results
        if (result.references) {
          allReferences.push(...result.references);
        }

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

  const seen = new Set<string>();
  const finalRefs = allReferences.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
  return {
    text: "I hit the maximum number of tool calls for this request. Here's what I found so far — please ask a more specific question if you need more detail.",
    issueProposal,
    references: finalRefs,
  };
}
