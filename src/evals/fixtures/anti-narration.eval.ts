import { describe, it, expect } from "vitest";
import { runEval } from "../run-eval";
import { hasNoNarration } from "../rubric";

describe("eval: anti-narration", () => {
  it("a factual question produces no narration phrases", async () => {
    const result = await runEval("What does battle-mage do?");
    const r = hasNoNarration(result.text);
    expect(r.pass, r.detail).toBe(true);
  });

  it("a code-lookup question produces no narration phrases", async () => {
    const result = await runEval("Where is the signature verification logic?");
    const r = hasNoNarration(result.text);
    expect(r.pass, r.detail).toBe(true);
  });
});
