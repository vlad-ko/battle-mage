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
    // Assert the substituted LINE, not just the word "followup" — the
    // template's own descriptive text contains both mode words, so a
    // bare toContain("followup") passes even if <INVOCATION> is never
    // replaced.
    expect(seen).toContain("Invocation mode: followup");
    expect(seen).not.toContain("<INVOCATION>");
    expect(seen).not.toContain("<TRANSCRIPT>");
    expect(seen).not.toContain("<QUESTION>");
  });

  it("substitutes the mention invocation mode", async () => {
    let seen = "";
    const call = async (prompt: string) => {
      seen = prompt;
      return JSON.stringify(VALID);
    };
    await classifyTurn({ ...input, invocation: "mention" }, { call, log: vi.fn() });
    expect(seen).toContain("Invocation mode: mention");
    expect(seen).not.toContain("<INVOCATION>");
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

  it("tolerates an untagged ``` fence too", async () => {
    const call = async () => "```\n" + JSON.stringify(VALID) + "\n```";
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

  it("validates effortConfidence independently of shouldReplyConfidence", async () => {
    // Each confidence field has its own guard — dropping either one is a
    // mutation this must catch.
    for (const bad of [1.5, -0.1, Number.NaN, "0.9", undefined]) {
      const log = vi.fn();
      const result = await classifyTurn(input, {
        call: callReturning({ ...VALID, effortConfidence: bad }),
        log,
      });
      expect(result).toBeNull();
      expect(log).toHaveBeenCalledWith(
        "turn_classifier_error",
        expect.objectContaining({ reason: "invalid_shape" }),
      );
    }
  });

  it("rejects a non-boolean shouldReply (string 'true') as invalid_shape", async () => {
    const log = vi.fn();
    const result = await classifyTurn(input, {
      call: callReturning({ ...VALID, shouldReply: "true" }),
      log,
    });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      "turn_classifier_error",
      expect.objectContaining({ reason: "invalid_shape" }),
    );
  });

  it("rejects JSON null and scalar payloads as invalid_shape without throwing", async () => {
    // JSON.parse("null") is valid JSON — the null guard in
    // validateClassification is what keeps classifyTurn from throwing on
    // property access, upholding its NEVER-throws contract.
    for (const raw of ["null", "42", '"quick"']) {
      const log = vi.fn();
      const result = await classifyTurn(input, { call: async () => raw, log });
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

  it("does not fire the timeout before CLASSIFIER_TIMEOUT_MS", async () => {
    // Boundary partner to the timeout test: 1ms short of the wall the
    // call must still be allowed to win the race.
    vi.useFakeTimers();
    const log = vi.fn();
    let resolveCall!: (v: string) => void;
    const call = () => new Promise<string>((res) => (resolveCall = res));
    const pending = classifyTurn(input, { call, log });
    await vi.advanceTimersByTimeAsync(CLASSIFIER_TIMEOUT_MS - 1);
    resolveCall(JSON.stringify(VALID));
    const result = await pending;
    expect(result).toEqual(VALID);
    expect(log).not.toHaveBeenCalledWith("turn_classifier_error", expect.anything());
  });

  it("clears the timeout timer on the win path (no dangling handle)", async () => {
    // A surviving 3s timer would hold the serverless event loop open
    // after every fast classifier response. Deleting the clearTimeout in
    // the finally block must fail this test.
    vi.useFakeTimers();
    const result = await classifyTurn(input, {
      call: callReturning(VALID),
      log: vi.fn(),
    });
    expect(result).toEqual(VALID);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout timer on the error path too", async () => {
    vi.useFakeTimers();
    const result = await classifyTurn(input, {
      call: async () => {
        throw new Error("boom");
      },
      log: vi.fn(),
    });
    expect(result).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
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

  it("declines on a low-confidence yes while keeping the decision and effort", async () => {
    // The route distinguishes decline reasons: decision !== null with
    // shouldReply=true maps to "low_confidence". The gate must read
    // shouldReplyConfidence, NOT effortConfidence.
    const result = await evaluateFollowup(input, {
      call: callReturning({ ...VALID, shouldReplyConfidence: 0.6, effortConfidence: 0.9 }),
      log: vi.fn(),
    });
    expect(result.proceed).toBe(false);
    expect(result.decision?.shouldReply).toBe(true);
    expect(result.decision?.shouldReplyConfidence).toBe(0.6);
    expect(result.effort).toBe("quick"); // effort verdict is independent of the gate
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

const ABORT_INPUT = {
  invocation: "followup" as const,
  transcript: "user: how does auth work?\nbot: Auth uses JWT tokens.",
  question: "which file was that in?",
};

// ── Qodo finding 2 (PR #131): timeout must abort the underlying call ──

describe("classifyTurn abort propagation", () => {
  it("aborts the underlying call's signal when the timeout fires", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const call = vi.fn((_p: string, signal?: AbortSignal) => {
      seen = signal;
      return new Promise<string>(() => {}); // hangs past the timeout
    });
    const pending = classifyTurn(ABORT_INPUT, { call, log: vi.fn() });
    await vi.advanceTimersByTimeAsync(CLASSIFIER_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBeNull();
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(true);
  });

  it("does not abort the signal when the call wins the race", async () => {
    let seen: AbortSignal | undefined;
    const call = vi.fn((_p: string, signal?: AbortSignal) => {
      seen = signal;
      return Promise.resolve(JSON.stringify(VALID));
    });
    await expect(classifyTurn(ABORT_INPUT, { call, log: vi.fn() })).resolves.toEqual(VALID);
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);
  });
});
