import { describe, it, expect } from "vitest";
import { parseProposalFromMessage, extractIssueProposal } from "./create-issue";

describe("parseProposalFromMessage", () => {
  const makeProposal = (opts: { title: string; labels?: string; body: string }) => {
    const labelsLine = opts.labels ? `\n*Labels:* ${opts.labels}` : "";
    return [
      "Here's my analysis...",
      "",
      "───────────────────",
      `*Proposed Issue:* ${opts.title}${labelsLine}`,
      "",
      opts.body,
      "",
      "React with :white_check_mark: to create this issue, or ignore to cancel.",
    ].join("\n");
  };

  it("parses title from *Proposed Issue:* line", () => {
    const result = parseProposalFromMessage(
      makeProposal({ title: "Fix login timeout", body: "Users see errors" }),
    );
    expect(result?.title).toBe("Fix login timeout");
  });

  it("parses labels from *Labels:* line", () => {
    const result = parseProposalFromMessage(
      makeProposal({ title: "Bug", labels: "bug, high-priority", body: "Details" }),
    );
    expect(result?.labels).toEqual(["bug", "high-priority"]);
  });

  it("parses body between anchor and confirmation line", () => {
    const result = parseProposalFromMessage(
      makeProposal({ title: "Bug", body: "## Problem\nLogin fails on Safari" }),
    );
    expect(result?.body).toContain("Login fails on Safari");
  });

  it("returns null when no proposal marker found", () => {
    expect(parseProposalFromMessage("Just a normal message")).toBeNull();
  });

  it("returns null when confirmation line missing", () => {
    const text = "*Proposed Issue:* Fix bug\n\nSome body text";
    expect(parseProposalFromMessage(text)).toBeNull();
  });

  it("returns null when body is empty", () => {
    const text = [
      "*Proposed Issue:* Fix bug",
      "",
      "React with :white_check_mark: to create this issue, or ignore to cancel.",
    ].join("\n");
    expect(parseProposalFromMessage(text)).toBeNull();
  });

  it("handles proposals without labels", () => {
    const result = parseProposalFromMessage(
      makeProposal({ title: "Add tests", body: "We need unit tests" }),
    );
    expect(result?.title).toBe("Add tests");
    expect(result?.labels).toBeUndefined();
    expect(result?.body).toContain("We need unit tests");
  });

  it("handles multi-line body text", () => {
    const body = "## Problem\nLine 1\n\n## Steps\n1. Do this\n2. Do that";
    const result = parseProposalFromMessage(
      makeProposal({ title: "Bug", body }),
    );
    expect(result?.body).toContain("Line 1");
    expect(result?.body).toContain("1. Do this");
    expect(result?.body).toContain("2. Do that");
  });
});

describe("extractIssueProposal", () => {
  it("extracts title and body", () => {
    const result = extractIssueProposal({ title: "Fix bug", body: "Details" });
    expect(result.title).toBe("Fix bug");
    expect(result.body).toBe("Details");
  });

  it("extracts labels when present", () => {
    const result = extractIssueProposal({ title: "X", body: "Y", labels: ["bug"] });
    expect(result.labels).toEqual(["bug"]);
  });

  it("returns undefined labels when not present", () => {
    const result = extractIssueProposal({ title: "X", body: "Y" });
    expect(result.labels).toBeUndefined();
  });
});
