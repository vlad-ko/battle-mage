import { describe, it, expect, vi, afterEach } from "vitest";
import {
  CONFIDENCE_THRESHOLD,
  CLASSIFIER_TIMEOUT_MS,
  EFFORT_BUDGETS,
  TURN_CLASSIFIER_PROMPT,
  classifyTurn,
  decideShouldReply,
  decideEffort,
  buildEffortHint,
  evaluateFollowup,
  type TurnClassification,
} from "./effort-routing";
import { MAX_TOOL_ROUNDS, ANSWER_BUDGET_CHARS } from "./claude";

// Shared fixture: a fully-valid classifier verdict. Individual tests
// spread-override single fields to probe each validation branch.
const VALID: TurnClassification = {
  shouldReply: true,
  shouldReplyConfidence: 0.9,
  effort: "quick",
  effortConfidence: 0.9,
};

function callReturning(value: unknown): (prompt: string) => Promise<string> {
  return async () => JSON.stringify(value);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("constants", () => {
  it("threshold is 0.75 and timeout is 3000ms", () => {
    expect(CONFIDENCE_THRESHOLD).toBe(0.75);
    expect(CLASSIFIER_TIMEOUT_MS).toBe(3000);
  });

  it("EFFORT_BUDGETS maps quick/standard/deep to round + answer budgets", () => {
    expect(EFFORT_BUDGETS.quick).toEqual({ maxRounds: 4, answerCharsTarget: 1200 });
    expect(EFFORT_BUDGETS.standard).toEqual({
      maxRounds: 10,
      answerCharsTarget: ANSWER_BUDGET_CHARS,
    });
    expect(EFFORT_BUDGETS.deep).toEqual({
      maxRounds: MAX_TOOL_ROUNDS,
      answerCharsTarget: 6000,
    });
  });
});

describe("TURN_CLASSIFIER_PROMPT", () => {
  it("carries the transcript and question placeholders", () => {
    expect(TURN_CLASSIFIER_PROMPT).toContain("<TRANSCRIPT>");
    expect(TURN_CLASSIFIER_PROMPT).toContain("<QUESTION>");
  });

  it("demands JSON-only output with the exact four keys", () => {
    expect(TURN_CLASSIFIER_PROMPT).toMatch(/JSON/);
    for (const key of [
      "shouldReply",
      "shouldReplyConfidence",
      "effort",
      "effortConfidence",
    ]) {
      expect(TURN_CLASSIFIER_PROMPT).toContain(key);
    }
  });

  it("names all three effort buckets", () => {
    for (const bucket of ["quick", "standard", "deep"]) {
      expect(TURN_CLASSIFIER_PROMPT).toContain(`"${bucket}"`);
    }
  });

  it("states the invocation mode (followup vs mention differ)", () => {
    expect(TURN_CLASSIFIER_PROMPT).toContain("followup");
    expect(TURN_CLASSIFIER_PROMPT).toContain("mention");
  });
});

describe("decideShouldReply", () => {
  it("fails closed on null classification", () => {
    expect(decideShouldReply(null)).toBe(false);
  });

  it("proceeds on a confident yes", () => {
    expect(decideShouldReply({ ...VALID, shouldReplyConfidence: 0.9 })).toBe(true);
  });

  it("passes at exactly the threshold (>= semantics)", () => {
    expect(
      decideShouldReply({ ...VALID, shouldReplyConfidence: CONFIDENCE_THRESHOLD }),
    ).toBe(true);
  });

  it("fails closed just below the threshold", () => {
    expect(decideShouldReply({ ...VALID, shouldReplyConfidence: 0.74 })).toBe(false);
  });

  it("stays silent on a confident no", () => {
    expect(
      decideShouldReply({ ...VALID, shouldReply: false, shouldReplyConfidence: 0.99 }),
    ).toBe(false);
  });
});

describe("decideEffort", () => {
  it("defaults to standard on null classification", () => {
    expect(decideEffort(null)).toBe("standard");
  });

  it("honors a confident bucket", () => {
    expect(decideEffort({ ...VALID, effort: "quick", effortConfidence: 0.9 })).toBe("quick");
    expect(decideEffort({ ...VALID, effort: "deep", effortConfidence: 0.9 })).toBe("deep");
  });

  it("passes at exactly the threshold (>= semantics)", () => {
    expect(
      decideEffort({ ...VALID, effort: "deep", effortConfidence: CONFIDENCE_THRESHOLD }),
    ).toBe("deep");
  });

  it("defaults to standard below the threshold", () => {
    expect(decideEffort({ ...VALID, effort: "quick", effortConfidence: 0.5 })).toBe(
      "standard",
    );
  });
});

describe("buildEffortHint", () => {
  it("returns empty string for standard (byte-identical default path)", () => {
    expect(buildEffortHint("standard")).toBe("");
  });

  it("returns distinct non-empty hints for quick and deep", () => {
    const quick = buildEffortHint("quick");
    const deep = buildEffortHint("deep");
    expect(quick.length).toBeGreaterThan(0);
    expect(deep.length).toBeGreaterThan(0);
    expect(quick).not.toBe(deep);
  });
});

describe("classifyTurn", () => {
  const input = {
    invocation: "followup" as const,
    transcript: "user: how does auth work?\nbot: Auth uses JWT tokens.",
    question: "which file was that in?",
  };

  it("returns the parsed classification on a valid response", async () => {
    const result = await classifyTurn(input, { call: callReturning(VALID), log: vi.fn() });
    expect(result).toEqual(VALID);
  });

  it("substitutes transcript, question, and invocation into the prompt", async () => {
    let seen = "";
    const call = async (prompt: string) => {
      seen = prompt;
      return JSON.stringify(VALID);
    };
    await classifyTurn(input, { call, log: vi.fn() });
    expect(seen).toContain(input.transcript);
    expect(seen).toContain(input.question);
    expect(seen).toContain("followup");
    expect(seen).not.toContain("<TRANSCRIPT>");
    expect(seen).not.toContain("<QUESTION>");
  });

  it("does not interpret $-substitution patterns in user content", async () => {
    // String.replace treats "$&" in a string replacement as "the match" —
    // a message containing it must land in the prompt verbatim.
    let seen = "";
    const call = async (prompt: string) => {
      seen = prompt;
      return JSON.stringify(VALID);
    };
    await classifyTurn({ ...input, question: "what does $& mean here?" }, { call, log: vi.fn() });
    expect(seen).toContain("what does $& mean here?");
    expect(seen).not.toContain("<QUESTION>");
  });

  it("tolerates a fenced ```json response", async () => {
    const call = async () => "```json\n" + JSON.stringify(VALID) + "\n```";
    const result = await classifyTurn(input, { call, log: vi.fn() });
    expect(result).toEqual(VALID);
  });

  it("logs turn_classified with the full verdict on success", async () => {
    const log = vi.fn();
    await classifyTurn(input, { call: callReturning(VALID), log });
    expect(log).toHaveBeenCalledWith(
      "turn_classified",
      expect.objectContaining({
        invocation: "followup",
        shouldReply: true,
        shouldReplyConfidence: 0.9,
        effort: "quick",
        effortConfidence: 0.9,
        duration_ms: expect.any(Number),
        model: expect.any(String),
      }),
    );
  });

  it("returns null + malformed_json on unparseable output", async () => {
    const log = vi.fn();
    const result = await classifyTurn(input, { call: async () => "not json at all", log });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      "turn_classifier_error",
      expect.objectContaining({ reason: "malformed_json" }),
    );
  });

  it("returns null + invalid_shape when a key is missing", async () => {
    const { effort: _drop, ...missingKey } = VALID;
    const log = vi.fn();
    const result = await classifyTurn(input, { call: callReturning(missingKey), log });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      "turn_classifier_error",
      expect.objectContaining({ reason: "invalid_shape" }),
    );
  });

  it("rejects out-of-range confidences as invalid_shape, never clamps", async () => {
    for (const bad of [1.5, -0.1, Number.NaN]) {
      const log = vi.fn();
      const result = await classifyTurn(input, {
        call: callReturning({ ...VALID, shouldReplyConfidence: bad }),
        log,
      });
      expect(result).toBeNull();
      expect(log).toHaveBeenCalledWith(
        "turn_classifier_error",
        expect.objectContaining({ reason: "invalid_shape" }),
      );
    }
  });

  it("rejects an unknown effort bucket as invalid_shape", async () => {
    const log = vi.fn();
    const result = await classifyTurn(input, {
      call: callReturning({ ...VALID, effort: "medium" }),
      log,
    });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      "turn_classifier_error",
      expect.objectContaining({ reason: "invalid_shape" }),
    );
  });

  it("returns null + api_error on a rejected call", async () => {
    const log = vi.fn();
    const result = await classifyTurn(input, {
      call: async () => {
        throw new Error("overloaded");
      },
      log,
    });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      "turn_classifier_error",
      expect.objectContaining({ reason: "api_error", message: "overloaded" }),
    );
  });

  it("never throws even when the injected call throws synchronously", async () => {
    const log = vi.fn();
    const call = () => {
      throw new Error("sync boom");
    };
    const result = await classifyTurn(input, {
      call: call as unknown as (prompt: string) => Promise<string>,
      log,
    });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      "turn_classifier_error",
      expect.objectContaining({ reason: "api_error" }),
    );
  });

  it("times out after CLASSIFIER_TIMEOUT_MS and reports reason timeout", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const never = () => new Promise<string>(() => {});
    const pending = classifyTurn(input, { call: never, log });
    await vi.advanceTimersByTimeAsync(CLASSIFIER_TIMEOUT_MS);
    const result = await pending;
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      "turn_classifier_error",
      expect.objectContaining({ reason: "timeout" }),
    );
  });
});

describe("evaluateFollowup", () => {
  const input = {
    invocation: "followup" as const,
    transcript: "bot: The limit is 15 rounds.",
    question: "which file defines that?",
  };

  it("proceeds with the classified effort on a confident yes", async () => {
    const result = await evaluateFollowup(input, {
      call: callReturning({ ...VALID, effort: "quick" }),
      log: vi.fn(),
    });
    expect(result.proceed).toBe(true);
    expect(result.effort).toBe("quick");
    expect(result.decision).toEqual({ ...VALID, effort: "quick" });
  });

  it("declines on a confident no but still reports the decision", async () => {
    const result = await evaluateFollowup(input, {
      call: callReturning({ ...VALID, shouldReply: false }),
      log: vi.fn(),
    });
    expect(result.proceed).toBe(false);
    expect(result.decision?.shouldReply).toBe(false);
  });

  it("fails closed with standard effort on classifier error", async () => {
    const result = await evaluateFollowup(input, {
      call: async () => {
        throw new Error("down");
      },
      log: vi.fn(),
    });
    expect(result.proceed).toBe(false);
    expect(result.decision).toBeNull();
    expect(result.effort).toBe("standard");
  });
});
