import { describe, it, expect } from "vitest";
import { runScenario } from "../harness/scenario";
import {
  assertThreadOnly,
  assertMaxReferences,
  assertNoIssueCreated,
} from "../harness/contracts";

// Plain Q&A scenario: a fresh mention asking a code question. Contracts:
// every post lands in-thread (key design decision #3) and no message
// carries more than MAX_REFERENCES (7) reference bullets. A Q&A turn must
// also never touch createIssue.

describe("behavior: plain Q&A stays in-thread with capped references", () => {
  it("answers in the thread with at most 7 references and no GitHub writes", async () => {
    const world = await runScenario({
      id: "thread-only-refs",
      channel: "C0DEV",
      botUserId: "U0BM",
      users: { U0VJK: "vlad" },
      thread: [
        { user: "U0VJK", text: "<@U0BM> what does the reply splitter do?", ts: "1751371200.000100" },
      ],
      steps: [
        { kind: "mention", user: "U0VJK", text: "<@U0BM> what does the reply splitter do?", inThread: false },
        {
          kind: "expect",
          check: (w) => {
            // An answer was actually posted (not a silent turn).
            const posted = w.logEvents.find((e) => e.event === "answer_posted");
            expect(posted, "expected an answer_posted event").toBeTruthy();
            expect((posted?.data?.chunks as number) ?? 0).toBeGreaterThan(0);
            const noWrites = assertNoIssueCreated(w.githubCalls);
            expect(noWrites.pass, noWrites.detail).toBe(true);
          },
        },
      ],
    });

    const threadOnly = assertThreadOnly(world.slackCalls);
    expect(threadOnly.pass, threadOnly.detail).toBe(true);

    const finalTexts = world.slackWrites().map((c) => String(c.args.text ?? ""));
    const refCap = assertMaxReferences(finalTexts, 7);
    expect(refCap.pass, refCap.detail).toBe(true);
  });
});
