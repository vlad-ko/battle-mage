// ── Batch issue-creation helpers (pure) ──────────────────────────────
// Formats multi-proposal Slack messages, recognizes bulk-confirmation
// phrases, and summarizes per-issue creation outcomes.
//
// Keep this file side-effect-free — it's imported by the Slack route and
// by tests that run without KV/GitHub. All I/O (KV persistence, GitHub
// createIssue, Slack posting) lives in route.ts; this module only
// produces strings and classifies text.
//
// See #122 for context.

import type { IssueProposal } from "@/tools/create-issue";

// Shared divider + anchor strings. Exported so the legacy single-issue
// message parser (`parseProposalFromMessage` in tools/create-issue.ts)
// and these helpers stay in lock-step on the singular anchor.
export const SINGLE_PROPOSAL_ANCHOR = "*Proposed Issue:*";
export const BATCH_PROPOSAL_HEADER = "*Proposed Issues*";
export const DIVIDER = "───────────────────";
export const SINGLE_CONFIRM_LINE =
  "React with :white_check_mark: to create this issue, or ignore to cancel.";
export const BATCH_CONFIRM_LINE =
  "React with :white_check_mark: or say *confirm all* to create them all. Ignore to cancel.";

// ── Format ───────────────────────────────────────────────────────────
// For N=1: render the familiar single-proposal block (title, labels,
// body inline, singular confirmation). Keeps the existing UX unchanged
// for the common case and keeps the legacy parser happy for in-flight
// messages during the rollout window.
//
// For N>1: render a compact numbered list — title + inline labels only.
// Full bodies are NOT inlined; they are persisted in KV and pulled back
// when the user confirms. Inlining 8 bodies would blow Slack's 40k-char
// limit (see #112).

function formatSingle(p: IssueProposal): string {
  const labelsLine = p.labels?.length ? `\nLabels: ${p.labels.join(", ")}` : "";
  return [
    DIVIDER,
    `${SINGLE_PROPOSAL_ANCHOR} ${p.title}${labelsLine}`,
    "",
    p.body,
    "",
    SINGLE_CONFIRM_LINE,
  ].join("\n");
}

function formatBatch(proposals: IssueProposal[]): string {
  const header = `${BATCH_PROPOSAL_HEADER} — ${proposals.length} to file. ${BATCH_CONFIRM_LINE}`;
  const lines = proposals.map((p, i) => {
    const labelsTag = p.labels?.length ? ` — _${p.labels.join(", ")}_` : "";
    return `${i + 1}. *${p.title}*${labelsTag}`;
  });
  return [DIVIDER, header, "", ...lines].join("\n");
}

export function formatBatchProposalMessage(
  proposals: IssueProposal[],
): string {
  if (proposals.length === 0) return "";
  if (proposals.length === 1) return formatSingle(proposals[0]);
  return formatBatch(proposals);
}

// ── Bulk confirmation text matcher ───────────────────────────────────
// Intent: recognize short, approval-only phrases in a thread reply. Be
// conservative — a false positive fires GitHub writes. The guard is a
// strict allowlist of short phrases (≤ 6 words after normalization).
//
// Matches: "yes", "confirm all", "create all", "create them all",
//   "go ahead", "go ahead and create all issues", "approve all",
//   "approve", "confirm"
//
// Rejects anything longer or containing disqualifying tokens like
// "no", "don't", "only", "just", "this one", "#<digit>".

const ALLOWED_PATTERNS: RegExp[] = [
  /^y+e+s+$/,
  /^yes please$/,
  /^confirm$/,
  /^confirm all( issues| remaining)?$/,
  /^create all( issues| remaining)?$/,
  /^create them all$/,
  /^go ahead$/,
  /^go ahead and create( all| them)?( issues)?$/,
  /^approve$/,
  /^approve all$/,
];

const DISQUALIFIERS = /\b(no|not|don'?t|only|just|this|issue|#\d+)\b/;

function normalize(text: string): string {
  // Strip common punctuation, collapse whitespace, lowercase.
  return text
    .toLowerCase()
    .replace(/[.!?,;:"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isBulkConfirmText(text: string): boolean {
  const t = normalize(text);
  if (t.length === 0) return false;

  const wordCount = t.split(" ").length;
  // Hard upper bound — real approvals fit in a few words. Anything
  // longer is prose, not an approval.
  if (wordCount > 6) return false;

  // Reject if any disqualifier token is present — guards "yes it failed"
  // from matching even though it starts with "yes".
  if (DISQUALIFIERS.test(t)) return false;

  return ALLOWED_PATTERNS.some((rx) => rx.test(t));
}

// ── Summarize creation outcomes ──────────────────────────────────────

export type BatchCreationOutcome =
  | {
      status: "success";
      proposal: IssueProposal;
      issue: { number: number; title: string; url: string };
    }
  | {
      status: "error";
      proposal: IssueProposal;
      errorMessage: string;
    };

export function summarizeBatchResult(
  outcomes: BatchCreationOutcome[],
): string {
  if (outcomes.length === 0) return "";

  const successes = outcomes.filter(
    (o): o is Extract<BatchCreationOutcome, { status: "success" }> =>
      o.status === "success",
  );
  const failures = outcomes.filter(
    (o): o is Extract<BatchCreationOutcome, { status: "error" }> =>
      o.status === "error",
  );

  const lines: string[] = [];

  if (successes.length > 0) {
    const noun = successes.length === 1 ? "issue" : "issues";
    lines.push(`:white_check_mark: Created ${successes.length} ${noun}:`);
    for (const s of successes) {
      lines.push(`  • *#${s.issue.number}* <${s.issue.url}|${s.issue.title}>`);
    }
  }

  if (failures.length > 0) {
    if (lines.length > 0) lines.push("");
    const noun = failures.length === 1 ? "issue" : "issues";
    lines.push(
      `:warning: ${failures.length} ${noun} failed to create:`,
    );
    for (const f of failures) {
      lines.push(`  • *${f.proposal.title}* — ${f.errorMessage}`);
    }
  }

  return lines.join("\n");
}
