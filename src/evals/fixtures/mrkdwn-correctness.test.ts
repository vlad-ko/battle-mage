import { describe, it, expect } from "vitest";
import { runEval } from "../run-eval";
import {
  hasNoMarkdownLinks,
  hasNoDoubleAsterisks,
  hasNoMarkdownTables,
} from "../rubric";

describe("eval: Slack mrkdwn output contract", () => {
  it("doesn't emit [label](url) markdown links", async () => {
    const result = await runEval("Describe the tool system in battle-mage");
    const r = hasNoMarkdownLinks(result.text);
    expect(r.pass, r.detail).toBe(true);
  });

  it("doesn't emit **double-asterisk bold**", async () => {
    const result = await runEval("Describe the tool system in battle-mage");
    const r = hasNoDoubleAsterisks(result.text);
    expect(r.pass, r.detail).toBe(true);
  });

  it("doesn't emit markdown pipe-tables", async () => {
    const result = await runEval(
      "List the seven Claude tools and what each one does",
    );
    const r = hasNoMarkdownTables(result.text);
    expect(r.pass, r.detail).toBe(true);
  });
});
