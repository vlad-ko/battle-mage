import { describe, it, expect } from "vitest";
import {
  assertThreadOnly,
  assertMaxReferences,
  countReferenceLines,
  assertNoIssueCreated,
  assertSilentDecline,
} from "./contracts";

const post = (threadTs: string | undefined, text = "hi") => ({
  method: "chat.postMessage" as const,
  args: { channel: "C0DEV", ...(threadTs ? { thread_ts: threadTs } : {}), text },
});

describe("assertThreadOnly", () => {
  it("passes when every postMessage carries a thread_ts", () => {
    const r = assertThreadOnly([post("1700000000.0001"), post("1700000000.0001")]);
    expect(r.pass, r.detail).toBe(true);
  });

  it("fails on a channel-root post and names the offending text head", () => {
    const r = assertThreadOnly([post("1700000000.0001"), post(undefined, "rogue root post")]);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("rogue root post");
  });

  it("fails on an empty-string thread_ts (falsy boundary, not just missing)", () => {
    const r = assertThreadOnly([post("")]);
    expect(r.pass).toBe(false);
  });

  it("passes vacuously on zero calls (silent-decline scenarios post nothing)", () => {
    expect(assertThreadOnly([]).pass).toBe(true);
  });
});

describe("countReferenceLines", () => {
  const footer = (n: number) =>
    "\n\n───\n*References:*\n" +
    Array.from({ length: n }, (_, i) => `  • 📄 <https://github.com/o/r/blob/main/f${i}.ts|f${i}.ts>`).join("\n") +
    "\n_React with 👍 or 👎 to help me give better answers in the future._";

  it("returns 0 when there is no references footer", () => {
    expect(countReferenceLines("plain answer\n- bullet that is not a ref")).toBe(0);
  });

  it("counts exactly the bullet lines in the footer", () => {
    expect(countReferenceLines("answer" + footer(7))).toBe(7);
  });

  it("does not count bullet lines that appear BEFORE the footer", () => {
    expect(countReferenceLines("answer\n  • not a ref" + footer(2))).toBe(2);
  });
});

describe("assertMaxReferences", () => {
  const refText = (n: number) =>
    "answer\n\n───\n*References:*\n" +
    Array.from({ length: n }, (_, i) => `  • 🎫 <https://github.com/o/r/issues/${i}|#${i} t>`).join("\n");

  it("passes at 6 and exactly at the 7 boundary", () => {
    expect(assertMaxReferences([refText(6)], 7).pass).toBe(true);
    expect(assertMaxReferences([refText(7)], 7).pass).toBe(true);
  });

  it("fails at 8 with the observed count in the detail", () => {
    const r = assertMaxReferences([refText(8)], 7);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("8");
  });
});

describe("assertNoIssueCreated", () => {
  it("passes on an empty github log", () => {
    expect(assertNoIssueCreated([]).pass).toBe(true);
  });

  it("passes when only reads happened", () => {
    expect(assertNoIssueCreated([{ fn: "readFile", args: ["CLAUDE.md"] }]).pass).toBe(true);
  });

  it("fails on a createIssue call and surfaces the title", () => {
    const r = assertNoIssueCreated([{ fn: "createIssue", args: ["Fix flaky sweep test", "body", []] }]);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("Fix flaky sweep test");
  });
});

describe("assertSilentDecline", () => {
  const declineEvent = { event: "followup_reply_declined", data: { reason: "not_addressed" } };
  const read = { method: "conversations.replies" as const, args: { channel: "C0DEV", ts: "1" } };

  it("passes with zero Slack writes and a decline event (reads allowed)", () => {
    const r = assertSilentDecline([read], [declineEvent]);
    expect(r.pass, r.detail).toBe(true);
  });

  it("fails if ANY write happened — even a chat.update", () => {
    const r = assertSilentDecline([read, { method: "chat.update", args: { channel: "C0DEV", ts: "1", text: "…" } }], [declineEvent]);
    expect(r.pass).toBe(false);
  });

  it("fails when writes are zero but no decline event was logged (crash is not a decline)", () => {
    const r = assertSilentDecline([read], [{ event: "agent_turn_failed", data: {} }]);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("followup_reply_declined");
  });
});
