import { describe, it, expect } from "vitest";
import {
  formatBatchProposalMessage,
  isBulkConfirmText,
  summarizeBatchResult,
  BATCH_CONFIRM_LINE,
  type BatchCreationOutcome,
} from "./issue-batch";
import type { IssueProposal } from "@/tools/create-issue";

const p = (title: string, body = "Short body.", labels?: string[]): IssueProposal => ({
  title,
  body,
  labels,
});

// ── formatBatchProposalMessage ───────────────────────────────────────
describe("formatBatchProposalMessage — single proposal (parity with legacy)", () => {
  it("renders the *Proposed Issue:* anchor line for a single proposal", () => {
    const out = formatBatchProposalMessage([p("Fix login timeout")]);
    expect(out).toContain("*Proposed Issue:* Fix login timeout");
  });

  it("includes the body verbatim for a single proposal", () => {
    const out = formatBatchProposalMessage([p("Fix bug", "## Problem\nDetails here")]);
    expect(out).toContain("## Problem");
    expect(out).toContain("Details here");
  });

  it("includes labels line when labels present", () => {
    const out = formatBatchProposalMessage([p("Fix bug", "body", ["bug", "priority:high"])]);
    expect(out).toContain("Labels: bug, priority:high");
  });

  it("omits labels line when labels absent", () => {
    const out = formatBatchProposalMessage([p("Fix bug")]);
    expect(out).not.toContain("Labels:");
  });

  it("ends with the single-issue confirmation line", () => {
    const out = formatBatchProposalMessage([p("Fix bug")]);
    expect(out).toContain("React with :white_check_mark: to create this issue");
  });

  it("includes the divider separator", () => {
    const out = formatBatchProposalMessage([p("Fix bug")]);
    expect(out).toContain("───────────────────");
  });
});

describe("formatBatchProposalMessage — multi-proposal batch", () => {
  const three = [
    p("fix: STATUS_PROVISIONING never written", "Body 1", ["bug", "priority:high"]),
    p("fix: template RIA fetched outside transaction", "Body 2", ["bug"]),
    p("fix: stuck PROVISIONING rows never cleaned up", "Body 3"),
  ];

  it("uses *Proposed Issues* (plural) header for N>1", () => {
    const out = formatBatchProposalMessage(three);
    expect(out).toContain("*Proposed Issues*");
    // Guard: must NOT fall through to the singular anchor used by the legacy parser
    expect(out).not.toContain("*Proposed Issue:*");
  });

  it("shows the total count in the header", () => {
    const out = formatBatchProposalMessage(three);
    expect(out).toMatch(/3 to file/);
  });

  it("renders a numbered list with each title", () => {
    const out = formatBatchProposalMessage(three);
    expect(out).toContain("1. *fix: STATUS_PROVISIONING never written*");
    expect(out).toContain("2. *fix: template RIA fetched outside transaction*");
    expect(out).toContain("3. *fix: stuck PROVISIONING rows never cleaned up*");
  });

  it("preserves proposal order (order-sensitive)", () => {
    const out = formatBatchProposalMessage(three);
    const idx1 = out.indexOf("fix: STATUS_PROVISIONING");
    const idx2 = out.indexOf("fix: template RIA");
    const idx3 = out.indexOf("fix: stuck PROVISIONING");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  it("renders labels as inline italics per item when present", () => {
    const out = formatBatchProposalMessage(three);
    expect(out).toContain("_bug, priority:high_");
    expect(out).toContain("_bug_");
  });

  it("ends with the bulk-confirm footer line", () => {
    const out = formatBatchProposalMessage(three);
    expect(out).toContain(BATCH_CONFIRM_LINE);
    // The footer must mention both approval paths so users know their options
    expect(out).toMatch(/:white_check_mark:/);
    expect(out).toMatch(/confirm all/i);
  });

  it("does NOT inline the full bodies (keeps message compact)", () => {
    // Bodies are stored in KV and retrieved on confirmation, not round-tripped
    // through the Slack message. Inlining 8 full bodies would blow past
    // Slack's 40k char limit and re-introduce the same msg_too_long risk
    // fixed in #112. For N>1, only titles + labels render.
    const out = formatBatchProposalMessage(three);
    expect(out).not.toContain("Body 1");
    expect(out).not.toContain("Body 2");
    expect(out).not.toContain("Body 3");
  });

  it("handles a large batch (8 proposals) without error", () => {
    const eight = Array.from({ length: 8 }, (_, i) => p(`issue ${i}`, `body ${i}`));
    const out = formatBatchProposalMessage(eight);
    expect(out).toContain("8 to file");
    for (let i = 0; i < 8; i++) {
      expect(out).toContain(`${i + 1}. *issue ${i}*`);
    }
  });
});

describe("formatBatchProposalMessage — edge cases", () => {
  it("returns empty string when proposals array is empty", () => {
    // Pure helper; route.ts never calls with [], but defending against it is
    // cheaper than debugging a malformed message in prod.
    expect(formatBatchProposalMessage([])).toBe("");
  });
});

// ── isBulkConfirmText ────────────────────────────────────────────────
describe("isBulkConfirmText — positive matches", () => {
  const positives = [
    "yes",
    "Yes",
    "YES",
    "yes!",
    "yes please",
    "confirm",
    "confirm all",
    "confirm all issues",
    "create all",
    "create all remaining",
    "create them all",
    "go ahead",
    "go ahead and create them",
    "go ahead and create all issues",
    "approve all",
    "approve",
    "  confirm all  ", // trimmed
    "Yes.",
  ];

  for (const text of positives) {
    it(`matches: ${JSON.stringify(text)}`, () => {
      expect(isBulkConfirmText(text)).toBe(true);
    });
  }
});

describe("isBulkConfirmText — negative matches (must NOT trigger)", () => {
  const negatives = [
    "",
    "   ",
    "no",
    "no thanks",
    "maybe later",
    "cancel",
    "don't",
    "yes it failed",              // 'yes' substring but not a bare confirm
    "yes this is a bug",
    "create only issue 1",
    "create this one",
    "create just the first",
    "approve only the epic",
    "confirm issue 3",
    "tell me more about issue 2",
    "what's the difference between #1 and #2", // long conversational
    "go ahead with just the first one",
    "let's not",
    // Long-form answers that contain 'yes' or 'ok' but are actually explanations,
    // not approvals. The matcher must require SHORT intent-only phrases.
    "yes we had the same bug last quarter, the fix was to move it out of the transaction",
  ];

  for (const text of negatives) {
    it(`rejects: ${JSON.stringify(text)}`, () => {
      expect(isBulkConfirmText(text)).toBe(false);
    });
  }
});

// ── summarizeBatchResult ─────────────────────────────────────────────
describe("summarizeBatchResult", () => {
  const success = (num: number, title: string): BatchCreationOutcome => ({
    status: "success",
    proposal: p(title),
    issue: { number: num, title, url: `https://github.com/o/r/issues/${num}` },
  });
  const failure = (title: string, errorMessage: string): BatchCreationOutcome => ({
    status: "error",
    proposal: p(title),
    errorMessage,
  });

  it("renders all-success summary with per-issue links and numbers", () => {
    const out = summarizeBatchResult([
      success(100, "fix: a"),
      success(101, "fix: b"),
      success(102, "fix: c"),
    ]);
    expect(out).toContain("3 issue");              // plural wording, exact count
    expect(out).toContain("#100");
    expect(out).toContain("#101");
    expect(out).toContain("#102");
    expect(out).toContain("<https://github.com/o/r/issues/100|fix: a>");
    expect(out).toContain(":white_check_mark:");
  });

  it("renders single-success summary in singular form", () => {
    const out = summarizeBatchResult([success(42, "fix: only one")]);
    expect(out).toContain("#42");
    // Singular — no trailing 's' in "1 issue"
    expect(out).toMatch(/1 issue(?!s)/);
  });

  it("reports mixed success + failure without dropping either side", () => {
    const out = summarizeBatchResult([
      success(200, "fix: ok"),
      failure("fix: broken title", "rate limited"),
      success(201, "fix: also ok"),
    ]);
    expect(out).toContain("#200");
    expect(out).toContain("#201");
    expect(out).toContain("fix: broken title");
    expect(out).toContain("rate limited");
    // Mixed result must signal that not everything succeeded
    expect(out).toMatch(/failed|couldn't|could not|error/i);
  });

  it("renders all-failure summary without claiming any success", () => {
    const out = summarizeBatchResult([
      failure("fix: a", "perm denied"),
      failure("fix: b", "rate limited"),
    ]);
    expect(out).not.toContain(":white_check_mark:");
    expect(out).toContain("fix: a");
    expect(out).toContain("fix: b");
    expect(out).toContain("perm denied");
    expect(out).toContain("rate limited");
  });

  it("returns an empty string for an empty outcome array", () => {
    // Defensive — route.ts never calls with []
    expect(summarizeBatchResult([])).toBe("");
  });
});
