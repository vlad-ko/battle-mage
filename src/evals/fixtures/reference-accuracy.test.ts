import { describe, it, expect } from "vitest";
import { runEval } from "../run-eval";
import { referenceLabelsInclude } from "../rubric";

describe("eval: reference accuracy", () => {
  it("Slack signature question returns a reference to slack.ts", async () => {
    const result = await runEval(
      "Where is the Slack signature verification implemented?",
    );
    const r = referenceLabelsInclude(result.references, "slack.ts");
    expect(r.pass, r.detail).toBe(true);
  });

  it("agent loop question returns a reference to claude.ts", async () => {
    const result = await runEval(
      "Show me the main agent loop — which file implements it?",
    );
    const r = referenceLabelsInclude(result.references, "claude.ts");
    expect(r.pass, r.detail).toBe(true);
  });
});
