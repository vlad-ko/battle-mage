import Anthropic from "@anthropic-ai/sdk";
import { tools, executeTool, type ToolResult, type Reference } from "@/tools";
import type { IssueProposal } from "@/tools/create-issue";
import { readFile } from "@/lib/github";
import { getKnowledgeAsMarkdown } from "@/lib/knowledge";
import { getFeedbackAsMarkdown } from "@/lib/feedback";
import { getOrRebuildIndex, getCachedConfig } from "@/lib/repo-index";
import { log, type RequestLogger } from "@/lib/logger";
import { classifyApiError, userErrorMessage } from "@/lib/api-error";
import { shouldWarnBudget, shouldForceStop } from "@/lib/time-budget";
import type { BattleMageConfig } from "@/lib/config";

// ── Anthropic client ──────────────────────────────────────────────────
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const MODEL = "claude-sonnet-4-6";
export const MAX_TOOL_ROUNDS = 15;

// Output contract knobs
export const MAX_ANSWER_LINES = 15;
export const RECENCY_WINDOW_DAYS = 30;

// Hard cap on any single tool_result before it is appended to the agent's
// messages array. Prevents broad research prompts (list_issues, list_prs,
// read_file of a large source file, etc.) from piling up enough content
// to push the next messages.stream() call past the model's 200k context
// window and crash the turn with msg_too_long. See #92.
//
// ~7.5k tokens (at ~4 chars/token). Conservative first pass — raise if we
// see the truncation firing on typical reads.
export const TOOL_RESULT_MAX_CHARS = 30_000;

// Pure helper: truncates a tool_result to TOOL_RESULT_MAX_CHARS INCLUSIVE
// of the tail suffix, so callers can budget against the constant as a
// true hard cap. Exported for unit testing.
export function truncateToolResult(text: string): { text: string; truncated: boolean } {
  if (text.length <= TOOL_RESULT_MAX_CHARS) {
    return { text, truncated: false };
  }
  // Compose the tail first so we know the budget left for the head.
  const tail =
    `\n\n[tool result truncated — original length ${text.length} chars, ` +
    `capped at ${TOOL_RESULT_MAX_CHARS}. If you need more of this content, ` +
    `call the tool again with a narrower query or a specific line range.]`;
  const headLen = Math.max(0, TOOL_RESULT_MAX_CHARS - tail.length);
  const head = text.slice(0, headLen);
  return { text: head + tail, truncated: true };
}

// Cumulative budget for the messages array. TOOL_RESULT_MAX_CHARS caps a
// single result; this caps the sum across all rounds. Chosen to leave
// ~50k tokens of headroom for:
//   - System prompt stable zone (~8k) + volatile zone (~3k)
//   - Tool schemas (~2k)
//   - max_tokens output (4096)
//   - Safety margin for estimation error
// Sonnet-4-6's context window is 200k; 150k keeps us safely under even
// with a slightly oversized system prompt or a fluctuating volatile tail.
export const MESSAGES_SAFE_BUDGET_TOKENS = 150_000;

// Chars-per-token heuristic, biased low for safety (overestimates tokens).
// Real Claude tokenization is closer to 3.5–4 chars/token for English +
// code. Using 3 gives a ~15% buffer against surprise expansion.
const CHARS_PER_TOKEN = 3;

// Rough token estimator for an Anthropic messages array. Walks every
// content block type the SDK can produce (string, text, tool_use,
// tool_result) and sums char counts / CHARS_PER_TOKEN. Exported for
// unit testing and for external pre-flight checks.
export function estimateMessagesTokens(messages: Anthropic.MessageParam[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type === "text") {
        chars += block.text.length;
      } else if (block.type === "tool_use") {
        chars += block.name.length;
        chars += JSON.stringify(block.input ?? {}).length;
      } else if (block.type === "tool_result") {
        if (typeof block.content === "string") {
          chars += block.content.length;
        } else if (Array.isArray(block.content)) {
          for (const inner of block.content) {
            if (inner.type === "text") chars += inner.text.length;
          }
        }
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

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

// ── Stable-zone section builders (cache-target above the breakpoint) ──
// These return content that rarely changes across turns; ordering matters
// so that a future cache_control breakpoint can sit at the end of the
// <output-contract> block and cover the whole stable zone.

function buildIdentitySection(owner: string | undefined, repo: string | undefined): string {
  return `<identity>
You are Battle Mage (@bm), an AI assistant embedded in Slack with read access to the ${owner}/${repo} GitHub repository. You answer engineering questions in-thread. You never post at channel root.
</identity>`;
}

function buildCorePrinciplesSection(): string {
  return `<core-principles>
1. *Verify before asserting* — Always use your tools to check that files, methods, and classes actually exist before referencing them. Never hallucinate code references.
2. *Cite specifically* — When referencing code, include the file path and line numbers. Link to GitHub when possible.
3. *Thread-only* — You are responding in a Slack thread. Keep answers concise but thorough.
4. *Issue creation requires confirmation* — If asked to create a GitHub issue, propose it with title, body, and labels. The user must explicitly confirm before it is created.
</core-principles>`;
}

function buildSourceHierarchySection(): string {
  return `<source-hierarchy>
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
</source-hierarchy>`;
}

function buildToolsSection(): string {
  return `<tools>
Available GitHub tools (do not invent names):
- *search_code*: Search for code patterns, function names, classes across the repo
- *read_file*: Read file contents or list directory entries
- *list_issues*: List or look up GitHub issues
- *list_commits*: List recent commits on main — newest first, with dates
- *list_prs*: List recent pull requests — shows merged/open status with dates
- *create_issue*: Propose a new GitHub issue (requires user confirmation)
- *save_knowledge*: Save a correction or fact to the persistent knowledge base
</tools>`;
}

function buildSearchStrategySection(): string {
  return `<search-strategy>
## Search Strategy — CRITICAL

You have a maximum of ${MAX_TOOL_ROUNDS} tool rounds per question. Budget them wisely.

*Step 1: Check the Repository Map FIRST* — Look at the Repository Map section in this prompt. It lists the key areas of the repo by topic (authentication, deployment, security, etc.). If the question maps to a topic, go directly to the listed files with \`read_file\`. Do NOT search if the map already tells you where to look.

*Step 2: Search only as fallback* — Use \`search_code\` ONLY if the repo map doesn't cover the topic, or if you need to find a specific function/class name. A search returns 10 results — don't read all of them.

*Step 3: Read 2-3 files maximum* — For most questions, 2-3 files from the relevant topic is enough. If you've read 3 files and have enough to answer, stop reading and synthesize.

*Step 4: Synthesize early* — Start forming your answer after 2-4 tool rounds. Don't exhaust all ${MAX_TOOL_ROUNDS} rounds trying to be exhaustive. A good focused answer is better than a comprehensive one that takes 5 minutes.

*Step 5: Use list tools sparingly* — \`list_issues\`, \`list_commits\`, and \`list_prs\` are for "what's new?" questions. Don't call them for code questions. Don't call multiple list tools in the same question unless specifically asked about activity.

*Anti-patterns to avoid:*
- Calling \`search_code\` when the repo map already points to the right files
- Reading 5+ files in a single question
- Calling \`list_issues\` + \`list_commits\` + \`list_prs\` in the same question
- Hitting the tool limit without producing an answer
- Trying to give an exhaustive answer to a vague question — suggest a follow-up to narrow the question instead
</search-strategy>`;
}

function buildKnowledgeBaseUsageSection(): string {
  return `<knowledge-base-usage>
## Knowledge Base — IMPORTANT

You have a persistent knowledge base stored in Vercel KV (not in the GitHub repo). Use it as follows:

*When to save:*
- A user corrects you ("no, that's in app/Services not app/Http")
- A user shares non-obvious insider knowledge ("we deprecated that endpoint last week")
- You discover something surprising that contradicts the codebase docs
- A user says "remember this" or similar

*How to save:*
- Use the \`save_knowledge\` tool IMMEDIATELY — do NOT search the repo first. When a user says "remember this", "memorize", "save to KB", or provides a correction, call save_knowledge as your very first action. No research needed.
- Write entries as standalone facts, not conversation snippets
- Be specific: include file paths, class names, version numbers
- Good: "The auth module is in app/Services/Auth, not app/Http/Auth"
- Bad: "User said auth is somewhere else"

*When reading:*
- Your knowledge base is loaded into this prompt below. It can become stale — always check the code first for code-level questions.
- If a knowledge entry conflicts with what you see in the code, the code is authoritative — flag the discrepancy.
</knowledge-base-usage>`;
}

function buildOutputContractSection(today: string): string {
  return `<output-contract>
## Output Contract — CRITICAL

You write for Slack, not GitHub. Every response must obey these rules.

*Slack mrkdwn format (NOT standard Markdown):*
- Bold: *text* (single asterisk, NOT double)
- Italic: _text_ (underscore)
- Code: \`text\` (backtick)
- Code blocks: \`\`\`text\`\`\` (triple backtick)
- Links: <url|text>
- Lists: use "- " or "• "
- NEVER use # or ## or ### for headings — Slack does not support them. Use *bold text* on its own line instead.
- NEVER use **double asterisks** — Slack renders them literally as **text**.
- NEVER use [text](url) markdown links — Slack renders them literally. Use <url|text> instead.
- NEVER use markdown tables (the pipe \`|\` row syntax) — Slack renders them broken. Use bullet lists instead.

*Anti-narration — do NOT emit any of these phrases:*
- "let me check"
- "i'll look into this" / "let me look"
- "one moment"
- "fetching now"
- "hold on while i..."
- "looking into that..."

Prefer a single result-focused reply after tool work completes. Don't pre-announce tool work or narrate intermediate steps — the user sees progress indicators separately.

*Brevity:*
- Lead with the direct answer in 2–3 sentences.
- Target ~${MAX_ANSWER_LINES} lines or fewer for a typical answer. Only go longer if the question genuinely requires depth.
- Use bullets for supporting details, not prose paragraphs.
- Skip editorializing: no "what makes this special", no marketing copy, no brochure-style overviews, no "comprehensive overview" essays. Just answer the question.
- Skip sections like "Development Maturity Indicators" or "Why This Is Impressive" — the user didn't ask for a pitch.
- Be direct and technical — this is an engineering team.
- If the user wants more detail, they'll ask a follow-up.

*Recency (today is ${today}):*
- Prefer the most recent activity first. When asked about "recent developments", "status", or "what's new", focus on the last ${RECENCY_WINDOW_DAYS} days.
- For "what's new" questions, check MULTIPLE sources: \`list_commits\`, \`list_prs\`, \`list_issues\`. Recent commits and merged PRs are the strongest signals.
- Skip \`docs/archive/\` — treat archive content as historical unless the user explicitly asks about history or past decisions.
- If all the information you found is older than ${RECENCY_WINDOW_DAYS} days, say so — don't present stale data as current.
</output-contract>`;
}

// ── Volatile-zone section builders (below a future cache breakpoint) ──
// Content that changes per-turn or per-project. Kept conditional to
// preserve existing test invariants (sections absent when data is null).

function buildRepoContextSection(owner: string | undefined, repo: string | undefined): string {
  return `<repo-context>
Owner: ${owner}
Repository: ${repo}
</repo-context>`;
}

function buildStableZone(inputs: PromptInputs): string {
  const today = new Date().toISOString().split("T")[0];
  return [
    buildIdentitySection(inputs.owner, inputs.repo),
    buildCorePrinciplesSection(),
    buildSourceHierarchySection(),
    buildToolsSection(),
    buildSearchStrategySection(),
    buildKnowledgeBaseUsageSection(),
    buildOutputContractSection(today),
  ].join("\n\n");
}

function buildVolatileZone(inputs: PromptInputs): string {
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

  return `\n\n${buildRepoContextSection(owner, repo)}\n${contextSection}${repoIndexSection}${annotationsSection}${knowledgeSection}${feedbackSection}`;
}

export function assembleSystemPrompt(inputs: PromptInputs): string {
  return buildStableZone(inputs) + buildVolatileZone(inputs);
}

// Returns the system prompt split for Anthropic prompt caching. The stable
// block carries an ephemeral cache_control breakpoint — Anthropic caches
// every content block up through and including that marker, so the entire
// stable zone is served from cache on subsequent turns in the same thread.
export function assembleSystemBlocks(inputs: PromptInputs): Anthropic.TextBlockParam[] {
  return [
    {
      type: "text",
      text: buildStableZone(inputs),
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: buildVolatileZone(inputs),
    },
  ];
}

// ── Async wrapper that fetches data then assembles ────────────────────
async function buildSystemBlocks(): Promise<Anthropic.TextBlockParam[]> {
  const repoIndex = await getOrRebuildIndex();
  const config = await getCachedConfig();
  return assembleSystemBlocks({
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
export type TextDeltaCallback = (snapshot: string) => void | Promise<void>;

// Invokes an optional text-delta callback safely. Swallows both synchronous
// throws and async rejections so a faulty handler cannot surface as an
// unhandled rejection and destabilize the runtime. Exported for testing.
export function safeInvokeTextDelta(
  onTextDelta: TextDeltaCallback | undefined,
  snapshot: string,
): void {
  if (!onTextDelta) return;
  Promise.resolve()
    .then(() => onTextDelta(snapshot))
    .catch(() => {});
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

async function anthropicCall(
  params: Anthropic.MessageCreateParamsNonStreaming,
  onTextDelta: TextDeltaCallback | undefined,
  _log: RequestLogger,
  round: number,
): Promise<Anthropic.Message> {
  try {
    const stream = anthropic.messages.stream(params);
    stream.on("text", (_delta, snapshot) => {
      safeInvokeTextDelta(onTextDelta, snapshot);
    });
    return await stream.finalMessage();
  } catch (streamErr) {
    _log("agent_stream_fallback", {
      round,
      error: streamErr instanceof Error ? streamErr.message : String(streamErr),
    });
    return await anthropic.messages.create(params);
  }
}

export async function runAgent(
  userMessage: string,
  onProgress?: ProgressCallback,
  conversationHistory?: ConversationTurn[],
  rlog?: RequestLogger,
  onTextDelta?: TextDeltaCallback,
): Promise<AgentResult> {
  // Use request-scoped logger if provided, fall back to bare log
  const _log: RequestLogger = rlog ?? log;

  // Build messages: optional history + current user message
  const messages: Anthropic.MessageParam[] = [
    ...(conversationHistory ?? []),
    { role: "user", content: userMessage },
  ];

  let issueProposal: IssueProposal | undefined;
  const allReferences: Reference[] = [];
  const startTime = Date.now();
  const systemBlocks = await buildSystemBlocks();
  const promptLength = systemBlocks.reduce((n, b) => n + b.text.length, 0);
  _log("agent_start", { promptLength, question: userMessage.slice(0, 100) });

  let warned = false;
  let contextWarned = false;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalInput = 0;
  let totalOutput = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Time budget check — force-stop if over 5 minutes
    if (shouldForceStop(startTime)) {
      _log("agent_timeout", { rounds: round, duration_ms: Date.now() - startTime });
      const seen = new Set<string>();
      const finalRefs = allReferences.filter((r) => {
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      });
      return {
        text: "I've been working on this for a while and want to give you what I have so far rather than keep you waiting. Here's my answer based on what I've found:\n\n_I ran out of time before completing a thorough analysis. Ask a follow-up question if you need more detail on a specific area._",
        issueProposal,
        references: finalRefs,
      };
    }

    let response;
    try {
      response = await anthropicCall(
        {
          model: MODEL,
          max_tokens: 4096,
          system: systemBlocks,
          tools,
          messages,
        },
        onTextDelta,
        _log,
        round,
      );
      totalInput += response.usage.input_tokens;
      totalOutput += response.usage.output_tokens;
      totalCacheRead += response.usage.cache_read_input_tokens ?? 0;
      totalCacheCreation += response.usage.cache_creation_input_tokens ?? 0;
    } catch (apiErr) {
      const errInfo = classifyApiError(apiErr);
      _log("agent_api_error", {
        round,
        status: errInfo.status,
        type: errInfo.type,
        category: errInfo.category,
        message: errInfo.message,
      });
      return {
        text: userErrorMessage(errInfo),
        issueProposal,
        references: [],
      };
    }

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
      _log("agent_complete", {
        rounds: round + 1,
        refCount: allReferences.length,
        hasProposal: !!issueProposal,
        duration_ms: Date.now() - startTime,
        input_tokens: totalInput,
        output_tokens: totalOutput,
        cache_read_tokens: totalCacheRead,
        cache_creation_tokens: totalCacheCreation,
      });
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

    // Context-budget exhaustion guard: if we already warned and the model
    // still issued tool calls, force exit with whatever text it produced
    // rather than running another round that would crash with msg_too_long.
    if (contextWarned) {
      _log("agent_context_exhausted", { round });
      const textBlocks = response.content.filter((b) => b.type === "text");
      const text = textBlocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      return {
        text:
          text ||
          "I gathered a lot of context while researching this. Here's what I've found so far — please ask a narrower follow-up if you need more detail on a specific area.",
        issueProposal,
        references: dedupeRefs(),
      };
    }

    // Add assistant message with all content blocks
    messages.push({ role: "assistant", content: response.content });

    // Execute all tool_use blocks concurrently. Claude often emits multiple
    // independent tool_use blocks in a single turn (e.g. "read A AND search
    // for B AND list PRs"); running them in parallel cuts wall time by 2-3×
    // with no cost impact. See #77.
    const parallelOutcome = await executeToolsInParallel(
      toolUseBlocks.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use"),
      { round, log: _log, onProgress },
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = parallelOutcome.toolResults;
    allReferences.push(...parallelOutcome.references);
    if (parallelOutcome.issueProposal) {
      issueProposal = parallelOutcome.issueProposal;
    }

    // Inject time budget warning by appending to the last tool result.
    // Re-run truncateToolResult on the combined string so the cap stays
    // honored even when appending to a result that is already at cap.
    if (!warned && shouldWarnBudget(startTime) && toolResults.length > 0) {
      warned = true;
      _log("agent_budget_warning", { round, elapsed_ms: Date.now() - startTime });
      const lastResult = toolResults[toolResults.length - 1];
      const existingContent = typeof lastResult.content === "string" ? lastResult.content : "";
      const combined = existingContent + "\n\n[SYSTEM] You are running low on time. Synthesize your answer NOW with what you have. Do not make more tool calls unless absolutely critical.";
      lastResult.content = truncateToolResult(combined).text;
    }

    // Context-budget warning: if appending these tool results would push
    // total messages tokens over MESSAGES_SAFE_BUDGET_TOKENS, inject a
    // synthesis directive so the model exits on the next round instead of
    // crashing with msg_too_long. Same shape as the time warning above.
    if (!contextWarned && toolResults.length > 0) {
      const projectedTokens = estimateMessagesTokens([
        ...messages,
        { role: "user", content: toolResults },
      ]);
      if (projectedTokens > MESSAGES_SAFE_BUDGET_TOKENS) {
        contextWarned = true;
        _log("agent_context_warning", { round, projected_tokens: projectedTokens });
        const lastResult = toolResults[toolResults.length - 1];
        const existingContent =
          typeof lastResult.content === "string" ? lastResult.content : "";
        const combined =
          existingContent +
          "\n\n[SYSTEM] Context window is nearly full. Synthesize your answer NOW with what you have. Do NOT call more tools.";
        lastResult.content = truncateToolResult(combined).text;
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

// ── Parallel tool dispatch ────────────────────────────────────────────
// When Claude emits multiple `tool_use` blocks in a single turn, execute
// them concurrently instead of serially. Per-tool failures are isolated:
// one tool throwing does not prevent the others from completing, and the
// failed tool still produces a `tool_result` with `is_error: true` so the
// model can reason about what went wrong.
//
// The `executor` parameter is injectable for tests; callers in prod leave
// it undefined and it defaults to the real `executeTool` from `@/tools`.

export interface ParallelToolsContext {
  round: number;
  log: RequestLogger;
  onProgress?: ProgressCallback;
  executor?: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ParallelToolsResult {
  toolResults: Anthropic.ToolResultBlockParam[];
  references: Reference[];
  issueProposal?: IssueProposal;
}

export async function executeToolsInParallel(
  blocks: Anthropic.ToolUseBlock[],
  ctx: ParallelToolsContext,
): Promise<ParallelToolsResult> {
  const exec = ctx.executor ?? executeTool;

  // Fire all tools concurrently. Each task logs + optionally pings progress
  // up front so the user sees every intended call before any finishes, then
  // awaits its executor. Progress is fire-and-forget so a slow or throwing
  // progress handler can't serialize the parallel dispatch — the whole
  // point of this function is wall-time reduction.
  const outcomes = await Promise.all(
    blocks.map(async (block) => {
      ctx.log("agent_tool_call", {
        tool: block.name,
        round: ctx.round,
        input: JSON.stringify(block.input).slice(0, 200),
      });
      if (ctx.onProgress) {
        Promise.resolve()
          .then(() => ctx.onProgress!(block.name, block.input as Record<string, unknown>))
          .catch(() => {
            // Progress is UX — never let it abort tool execution or surface
            // as an unhandled rejection.
          });
      }
      try {
        const result = await exec(block.name, block.input as Record<string, unknown>);
        return { block, result, error: null as string | null };
      } catch (err) {
        return {
          block,
          result: null as ToolResult | null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const toolResults: Anthropic.ToolResultBlockParam[] = [];
  const references: Reference[] = [];
  let issueProposal: IssueProposal | undefined;

  // Iterate outcomes in original block order so toolResults matches the
  // input sequence. Anthropic's API correlates results to uses by
  // `tool_use_id`, so order isn't strictly required for correctness — but
  // deterministic order eases log readability and test assertions.
  for (const { block, result, error } of outcomes) {
    if (error !== null) {
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: `Error: ${error}`,
        is_error: true,
      });
      continue;
    }
    const r = result!;
    if (r.references) {
      references.push(...r.references);
    }
    if (r.type === "issue_proposal") {
      issueProposal = r.proposal;
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: `Issue proposed: "${r.proposal.title}". Awaiting user confirmation in Slack before creation.`,
      });
    } else {
      const { text: capped, truncated } = truncateToolResult(r.text);
      if (truncated) {
        ctx.log("tool_result_truncated", {
          tool: block.name,
          round: ctx.round,
          original_chars: r.text.length,
          capped_chars: capped.length,
        });
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: capped,
      });
    }
  }

  return { toolResults, references, issueProposal };
}
