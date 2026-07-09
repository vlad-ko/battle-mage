import { describe, it, expect } from "vitest";
import { classifyTurn, decideShouldReply } from "@/lib/effort-routing";

/**
 * Eval: shouldReply classifier on representative thread transcripts.
 *
 * Hits the real Anthropic API (FAST_MODEL) via classifyTurn's default
 * call — runs ONLY under `npm run eval`, never in `npm test`
 * (vitest.config.ts excludes src/evals/fixtures/**). Each fixture is a
 * follow-up-shaped turn: the bot already replied in the thread, and the
 * classifier must decide whether the new message is addressed to it.
 */

async function shouldReply(transcript: string, question: string): Promise<boolean> {
  const decision = await classifyTurn({
    invocation: "followup",
    transcript,
    question,
  });
  return decideShouldReply(decision);
}

describe("eval: shouldReply follow-up gate", () => {
  const TRANSCRIPT = [
    "user: where is the tool-round limit enforced?",
    "bot: The agent loop in src/lib/claude.ts caps tool use at MAX_TOOL_ROUNDS (15) per turn.",
  ].join("\n");

  it("declines human-to-human chatter", async () => {
    const result = await shouldReply(
      TRANSCRIPT,
      "lol classic, anyway are we still on for lunch?",
    );
    expect(result).toBe(false);
  });

  it("declines a status update meant for teammates", async () => {
    const result = await shouldReply(
      TRANSCRIPT,
      "cool — I'll bump the limit in my branch and deploy after standup",
    );
    expect(result).toBe(false);
  });

  it("replies to a direct question about the bot's prior answer", async () => {
    const result = await shouldReply(
      TRANSCRIPT,
      "can you show me the exact loop where that cap is checked?",
    );
    expect(result).toBe(true);
  });

  it("replies to a follow-up lookup request", async () => {
    const result = await shouldReply(
      TRANSCRIPT,
      "which file defines the 15-round limit again?",
    );
    expect(result).toBe(true);
  });
});
