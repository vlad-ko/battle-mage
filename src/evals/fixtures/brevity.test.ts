import { describe, it, expect } from "vitest";
import { runEval } from "../run-eval";
import { isWithinCharLimit } from "../rubric";

describe("eval: brevity contract", () => {
  // The output contract targets ~15 lines typical. At ~80 chars/line that's
  // ~1200 chars; we allow 2500 to accommodate longer answers that are still
  // disciplined. A regression into editorializing would easily blow past 5000.
  const BREVITY_CHAR_LIMIT = 2500;

  it("factual code-location question stays under the brevity limit", async () => {
    const result = await runEval(
      "Where is the Slack signature verification implemented?",
    );
    const r = isWithinCharLimit(result.text, BREVITY_CHAR_LIMIT);
    expect(r.pass, r.detail).toBe(true);
  });

  it("project-overview question stays under the brevity limit", async () => {
    const result = await runEval("What does battle-mage do?");
    const r = isWithinCharLimit(result.text, BREVITY_CHAR_LIMIT);
    expect(r.pass, r.detail).toBe(true);
  });
});
