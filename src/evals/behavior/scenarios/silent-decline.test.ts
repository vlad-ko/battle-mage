import { describe, it, expect } from "vitest";
import { runScenario, type ScenarioSpec } from "../harness/scenario";
import { assertSilentDecline } from "../harness/contracts";

// All three decline reasons from the follow-up gate in
// src/lib/turn-runner.ts (runFollowupTurn → followup_reply_declined):
//   - "not_addressed"           shouldReply:false verdict
//   - "low_confidence"          shouldReply:true but confidence < 0.75
//   - "classifier_unavailable"  malformed/absent classifier verdict
//
// The boundary twins can't be reliably produced by a live model (an
// exact 0.74 confidence, a malformed payload), so at record time their
// classifier responses are crafted via recordOverrides and land in the
// cassette marked "synthetic": true. The classifier request is matched
// by model prefix — the follow-up gate is the only Haiku call in a
// declined turn.

const isClassifierRequest = (request: unknown): boolean =>
  String((request as { model?: string })?.model ?? "").startsWith("claude-haiku");

const classifierMessage = (payloadText: string) => ({
  id: "msg_synthetic",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5-20251001",
  content: [{ type: "text", text: payloadText }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 0, output_tokens: 0 },
});

const baseSpec = (id: string): Omit<ScenarioSpec, "steps" | "recordOverrides"> => ({
  id,
  channel: "C0DEV",
  botUserId: "U0BM",
  users: { U0VJK: "vlad" },
  thread: [
    { user: "U0VJK", text: "<@U0BM> where does the recovery sweep live?", ts: "1751371200.000100" },
    { user: "U0BM", text: "The sweep lives in src/app/api/cron/sweep/route.ts.", ts: "1751371260.000200" },
  ],
});

const followupSteps: ScenarioSpec["steps"] = [
  { kind: "followup", user: "U0VJK", text: "cool, anyway are we still on for lunch?" },
];

async function expectDecline(spec: ScenarioSpec, reason: string): Promise<void> {
  const world = await runScenario(spec);
  const r = assertSilentDecline(world.slackCalls, world.logEvents);
  expect(r.pass, r.detail).toBe(true);
  const declined = world.logEvents.find((e) => e.event === "followup_reply_declined");
  expect(declined?.data?.reason).toBe(reason);
}

describe("behavior: thread follow-ups fail closed to silence", () => {
  it("declines human-to-human chatter with reason not_addressed (zero Slack writes)", async () => {
    await expectDecline(
      {
        ...baseSpec("silent-decline-not-addressed"),
        steps: followupSteps,
      },
      "not_addressed",
    );
  });

  it("declines a just-under-threshold verdict (0.74 < 0.75) with reason low_confidence", async () => {
    await expectDecline(
      {
        ...baseSpec("silent-decline-low-confidence"),
        steps: followupSteps,
        recordOverrides: [
          {
            boundary: "anthropic",
            when: isClassifierRequest,
            response: classifierMessage(
              '{"shouldReply": true, "shouldReplyConfidence": 0.74, "effort": "standard", "effortConfidence": 0.9}',
            ),
          },
        ],
      },
      "low_confidence",
    );
  });

  it("declines on a malformed classifier payload with reason classifier_unavailable", async () => {
    await expectDecline(
      {
        ...baseSpec("silent-decline-classifier-unavailable"),
        steps: followupSteps,
        recordOverrides: [
          {
            boundary: "anthropic",
            when: isClassifierRequest,
            response: classifierMessage("I think probably yes? {not json"),
          },
        ],
      },
      "classifier_unavailable",
    );
  });
});
