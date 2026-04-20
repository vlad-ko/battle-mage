import { describe, it, expect, vi } from "vitest";
import {
  estimateConversationSize,
  shouldCompact,
  compactThread,
  THREAD_COMPACTION_TRIGGER_CHARS,
  MIN_PRESERVED_TURNS,
  COMPACTION_MARKER,
} from "./compaction";
import type { ConversationTurn } from "./claude";

describe("estimateConversationSize", () => {
  it("sums content lengths across turns", () => {
    const history: ConversationTurn[] = [
      { role: "user", content: "hello" }, // 5
      { role: "assistant", content: "hi there" }, // 8
      { role: "user", content: "x" }, // 1
    ];
    expect(estimateConversationSize(history)).toBe(14);
  });

  it("returns 0 for empty history", () => {
    expect(estimateConversationSize([])).toBe(0);
  });
});

describe("shouldCompact", () => {
  const makeTurns = (count: number, charsEach: number): ConversationTurn[] =>
    Array.from({ length: count }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: "x".repeat(charsEach),
    }));

  it("returns true when size exceeds trigger AND turns > MIN_PRESERVED", () => {
    // Enough turns (> MIN_PRESERVED) AND total content past the trigger.
    const history = makeTurns(
      MIN_PRESERVED_TURNS + 4,
      Math.ceil(THREAD_COMPACTION_TRIGGER_CHARS / (MIN_PRESERVED_TURNS + 4)) + 1,
    );
    expect(shouldCompact(history)).toBe(true);
  });

  it("returns false when size is under trigger", () => {
    const history = makeTurns(MIN_PRESERVED_TURNS + 4, 10);
    expect(shouldCompact(history)).toBe(false);
  });

  it("returns false when turns <= MIN_PRESERVED (nothing to compact)", () => {
    // Even with huge content, can't compact if every turn must be preserved.
    const history = makeTurns(MIN_PRESERVED_TURNS, 100_000);
    expect(shouldCompact(history)).toBe(false);
  });

  it("returns false for empty history", () => {
    expect(shouldCompact([])).toBe(false);
  });

  it("returns false for undefined-like history", () => {
    // Explicit empty array — shouldCompact never gets undefined in practice
    expect(shouldCompact([])).toBe(false);
  });
});

describe("compactThread", () => {
  const makeTurns = (count: number, charsEach: number): ConversationTurn[] =>
    Array.from({ length: count }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn ${i}: ${"x".repeat(charsEach)}`,
    }));

  it("returns history unchanged if there's nothing to compact", async () => {
    // If turns <= MIN_PRESERVED, compactThread is a no-op pass-through.
    const history = makeTurns(MIN_PRESERVED_TURNS, 100);
    const compactor = vi.fn().mockResolvedValue("summary");
    const result = await compactThread(history, { compactor, log: vi.fn() });
    expect(result).toEqual(history);
    expect(compactor).not.toHaveBeenCalled();
  });

  it("preserves all but the first of the preserved turns verbatim", async () => {
    // History even+aligned: last N turns preserved; the FIRST preserved
    // user turn gets the summary injected as leading context, the rest
    // are verbatim copies of the originals.
    const history = makeTurns(MIN_PRESERVED_TURNS + 6, 100);
    const compactor = vi.fn().mockResolvedValue("summary of early turns");

    const result = await compactThread(history, { compactor, log: vi.fn() });

    const originalPreserved = history.slice(-MIN_PRESERVED_TURNS);
    // Result length matches preserve count — summary rides INSIDE the
    // first user turn, not as its own message.
    expect(result).toHaveLength(MIN_PRESERVED_TURNS);
    // Turns 1..N are verbatim.
    expect(result.slice(1)).toEqual(originalPreserved.slice(1));
  });

  it("embeds summary into the first preserved turn with the marker", async () => {
    const history = makeTurns(MIN_PRESERVED_TURNS + 6, 100);
    const compactor = vi.fn().mockResolvedValue("summary of early turns");

    const result = await compactThread(history, { compactor, log: vi.fn() });

    // First turn keeps its role + original content; summary is prepended.
    expect(result[0].content).toContain(COMPACTION_MARKER);
    expect(result[0].content).toContain("summary of early turns");
    // Original first-preserved-turn content is still present (separator).
    expect(result[0].content).toContain(history[history.length - MIN_PRESERVED_TURNS].content);
  });

  it("logs a thread_compacted event with model + sizes", async () => {
    const history = makeTurns(MIN_PRESERVED_TURNS + 6, 100);
    const compactor = vi.fn().mockResolvedValue("compact summary");
    const log = vi.fn();

    await compactThread(history, { compactor, log });

    const compactLog = log.mock.calls.find((c) => c[0] === "thread_compacted");
    expect(compactLog).toBeDefined();
    expect(compactLog?.[1]).toMatchObject({
      turns_compacted: 6, // total - MIN_PRESERVED_TURNS
      turns_preserved: MIN_PRESERVED_TURNS,
    });
    expect(compactLog?.[1].chars_before).toBeGreaterThan(
      compactLog?.[1].chars_after,
    );
    // Must record which model did the compaction (per #75 ACs).
    expect(compactLog?.[1].model).toBeDefined();
    expect(typeof compactLog?.[1].model).toBe("string");
  });

  it("passes the older-turns transcript to the compactor", async () => {
    const history: ConversationTurn[] = [
      ...Array.from({ length: 6 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `OLD_TURN_${i}`,
      })),
      ...Array.from({ length: MIN_PRESERVED_TURNS }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `RECENT_TURN_${i}`,
      })),
    ];
    const compactor = vi.fn().mockResolvedValue("summary");

    await compactThread(history, { compactor, log: vi.fn() });

    expect(compactor).toHaveBeenCalledOnce();
    const prompt = compactor.mock.calls[0][0] as string;
    // Prompt should include the OLD turn contents and NOT the recent ones
    // (those are preserved verbatim so we don't summarize them twice).
    expect(prompt).toContain("OLD_TURN_0");
    expect(prompt).toContain("OLD_TURN_5");
    expect(prompt).not.toContain("RECENT_TURN_0");
  });

  it("produces a compacted sequence whose first turn is `user`", async () => {
    // Anthropic requires the messages array to start with a `user` turn.
    // compactThread must preserve that invariant whether the natural
    // preserve window starts with user OR assistant.
    const history = makeTurns(MIN_PRESERVED_TURNS + 4, 50);
    const compactor = vi.fn().mockResolvedValue("summary");

    const result = await compactThread(history, { compactor, log: vi.fn() });

    expect(result[0].role).toBe("user");
  });

  it("shifts one turn if natural preserve window starts with `assistant`", async () => {
    // Construct a history where slice(-MIN_PRESERVED_TURNS) starts with
    // assistant (odd alignment). Expect compactThread to shift by 1 so
    // preserve starts with user.
    const history: ConversationTurn[] = [
      { role: "user", content: "OLD_u0" },
      { role: "assistant", content: "OLD_a0" },
      { role: "user", content: "OLD_u1" },
      // Natural slice(-MIN_PRESERVED_TURNS) starts here:
      { role: "assistant", content: "OLD_a1" },
      { role: "user", content: "PRES_u0" },
      { role: "assistant", content: "PRES_a0" },
      { role: "user", content: "PRES_u1" },
      { role: "assistant", content: "PRES_a1" },
      { role: "user", content: "PRES_u2" },
    ];
    const compactor = vi.fn().mockResolvedValue("summary");

    const result = await compactThread(history, { compactor, log: vi.fn() });

    expect(result[0].role).toBe("user");
    expect(result[0].content).toContain("PRES_u0"); // first preserved user
    // The misaligned assistant turn (OLD_a1) got shifted INTO the compact
    // window so preserve begins user-aligned.
    const prompt = compactor.mock.calls[0][0] as string;
    expect(prompt).toContain("OLD_a1");
  });

  it("returns original history if the compactor throws (fail-safe)", async () => {
    const history = makeTurns(MIN_PRESERVED_TURNS + 4, 100);
    const compactor = vi.fn().mockRejectedValue(new Error("haiku down"));
    const log = vi.fn();

    const result = await compactThread(history, { compactor, log });

    // Compaction failure must not abort the turn — return original and
    // log the failure so the agent can still respond (possibly with more
    // tokens than ideal, but responding beats erroring out).
    expect(result).toEqual(history);
    const errorLog = log.mock.calls.find((c) => c[0] === "thread_compaction_error");
    expect(errorLog).toBeDefined();
  });
});
