import { describe, it, expect } from "vitest";
import { runScenario } from "../harness/scenario";
import { assertThreadOnly, assertNoIssueCreated } from "../harness/contracts";

describe("behavior: issue creation requires approval", () => {
  it("proposes without writing, creates exactly once on approval, refuses a double-approve", async () => {
    const world = await runScenario({
      id: "issue-approval-reaction",
      channel: "C0DEV",
      botUserId: "U0BM",
      users: { U0VJK: "vlad" },
      thread: [{ user: "U0VJK", text: "<@U0BM> file a GitHub issue titled 'Flaky sweep test: intermittent timing failure' with a short body noting the sweep test fails intermittently on slow CI runners, label it bug. No need to investigate the code first — just propose the issue.", ts: "1751371200.000100" }],
      steps: [
        { kind: "mention", user: "U0VJK", text: "<@U0BM> file a GitHub issue titled 'Flaky sweep test: intermittent timing failure' with a short body noting the sweep test fails intermittently on slow CI runners, label it bug. No need to investigate the code first — just propose the issue.", inThread: false },
        {
          kind: "expect",
          check: (w) => {
            // Contract half 1: proposal posted, ZERO GitHub writes so far.
            const r = assertNoIssueCreated(w.githubCalls);
            expect(r.pass, r.detail).toBe(true);
            // The pending batch is persisted (approval reads it, not message text).
            expect(w.kv.keysWithPrefix("pending-issue-batch:C0DEV:")).toHaveLength(1);
          },
        },
        { kind: "approveReaction", user: "U0VJK" },
        {
          kind: "expect",
          check: (w) => {
            // Contract half 2: exactly ONE create, with the proposed title.
            const creates = w.githubCalls.filter((c) => c.fn === "createIssue");
            expect(creates).toHaveLength(1);
            // A summary reply was posted in-thread after creation.
            const last = w.slackWrites().at(-1)!;
            expect(last.method).toBe("chat.postMessage");
            expect(last.args.thread_ts).toBe("1751371200.000100");
          },
        },
        // Double-tap boundary: second approval loses the del-claim race shape.
        { kind: "approveReaction", user: "U0VJK" },
        {
          kind: "expect",
          check: (w) => {
            expect(w.lastApproval?.claimed).toBe(false);
            expect(w.githubCalls.filter((c) => c.fn === "createIssue")).toHaveLength(1); // still 1
          },
        },
      ],
    });

    const threadOnly = assertThreadOnly(world.slackCalls);
    expect(threadOnly.pass, threadOnly.detail).toBe(true);
  });
});
