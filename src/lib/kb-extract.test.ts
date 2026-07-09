import { describe, it, expect, vi, afterEach } from "vitest";
import {
  KB_EXTRACTION_PROMPT,
  KB_EXTRACTOR_TIMEOUT_MS,
  MAX_KB_CANDIDATES,
  buildExtractionTranscript,
  parseExtractorOutput,
  extractKbCandidates,
  type KbCandidate,
} from "./kb-extract";

const VALID: KbCandidate = {
  entry: "The auth module lives in app/Services/Auth",
  kind: "correction",
  evidence: [0, 1],
  confidence: 0.9,
};
const payload = (candidates: unknown) => JSON.stringify({ candidates });

afterEach(() => {
  vi.useRealTimers();
});

describe("KB_EXTRACTION_PROMPT", () => {
  it("carries the transcript placeholder and demands JSON with the exact candidate keys", () => {
    expect(KB_EXTRACTION_PROMPT).toContain("<TRANSCRIPT>");
    for (const key of ["entry", "kind", "evidence", "confidence"]) {
      expect(KB_EXTRACTION_PROMPT).toContain(key);
    }
    expect(KB_EXTRACTION_PROMPT).toMatch(/JSON/);
  });
  it("names all three candidate kinds", () => {
    for (const kind of ["correction", "fact", "decision"]) {
      expect(KB_EXTRACTION_PROMPT).toContain(`"${kind}"`);
    }
  });
});

describe("buildExtractionTranscript", () => {
  const BOT = "UBOT";
  it("numbers entries after skipping empty-after-clean messages, so indices match the entries array", () => {
    const { rendered, entries } = buildExtractionTranscript(
      [
        { user: "U1", text: "how does auth work?", ts: "1751970000.000100" },
        { user: "U1", text: "<@UBOT>", ts: "1751970001.000100" }, // empty after mention strip → skipped
        { user: BOT, text: "Auth uses JWT.", ts: "1751970060.000200" },
      ],
      BOT,
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({ index: 1, author: "bot", ts: "1751970060.000200", text: "Auth uses JWT." });
    expect(rendered).toBe("[0] human: how does auth work?\n[1] bot: Auth uses JWT.");
  });
  it("marks bot_id messages as bot", () => {
    const { entries } = buildExtractionTranscript([{ bot_id: "B1", text: "hi", ts: "1.0" }], BOT);
    expect(entries[0].author).toBe("bot");
  });
  it("truncates long messages at 1000 chars with a trailing ellipsis", () => {
    const { entries } = buildExtractionTranscript([{ user: "U1", text: "a".repeat(1500), ts: "1.0" }], BOT);
    expect(entries[0].text).toBe("a".repeat(1000) + "...");
  });
  it("keeps only the most recent MAX messages", () => {
    const msgs = Array.from({ length: 70 }, (_, i) => ({ user: "U1", text: `m${i}`, ts: `${i}.0` }));
    const { entries } = buildExtractionTranscript(msgs, BOT);
    expect(entries).toHaveLength(60);
    expect(entries[0].text).toBe("m10");
    expect(entries[59].index).toBe(59);
  });
  it("returns empty results for an empty thread", () => {
    expect(buildExtractionTranscript([], BOT)).toEqual({ rendered: "", entries: [] });
  });
});

describe("parseExtractorOutput — envelope (shape strictness)", () => {
  it("parses a valid payload", () => {
    expect(parseExtractorOutput(payload([VALID]))).toEqual([VALID]);
  });
  it("strips a markdown code fence", () => {
    expect(parseExtractorOutput("```json\n" + payload([VALID]) + "\n```")).toEqual([VALID]);
  });
  it("returns null for malformed JSON", () => {
    expect(parseExtractorOutput("not json {")).toBeNull();
  });
  it.each([["a bare array", "[]"], ["a string envelope", '"hi"'], ["missing candidates", "{}"], ["non-array candidates", '{"candidates": 3}']])(
    "returns null for %s",
    (_label, raw) => {
      expect(parseExtractorOutput(raw)).toBeNull();
    },
  );
  it("returns [] for an empty candidates array (valid: nothing learned)", () => {
    expect(parseExtractorOutput(payload([]))).toEqual([]);
  });
  it("truncates to MAX_KB_CANDIDATES", () => {
    const many = Array.from({ length: MAX_KB_CANDIDATES + 2 }, (_, i) => ({ ...VALID, entry: `fact ${i}` }));
    expect(parseExtractorOutput(payload(many))).toHaveLength(MAX_KB_CANDIDATES);
  });
});

describe("parseExtractorOutput — per-candidate filtering", () => {
  it.each([
    ["non-string entry", { ...VALID, entry: 7 }],
    ["unknown kind", { ...VALID, kind: "opinion" }],
    ["non-array evidence", { ...VALID, evidence: "0,1" }],
    ["non-integer evidence element", { ...VALID, evidence: [0, 1.5] }],
    ["confidence above 1 (rejected, never clamped)", { ...VALID, confidence: 1.5 }],
    ["negative confidence", { ...VALID, confidence: -0.1 }],
    ["NaN confidence", { ...VALID, confidence: Number.NaN }],
  ])("filters a candidate with %s but keeps valid siblings", (_label, bad) => {
    expect(parseExtractorOutput(payload([bad, VALID]))).toEqual([VALID]);
  });
  it("accepts confidence boundaries 0 and 1", () => {
    expect(parseExtractorOutput(payload([{ ...VALID, confidence: 0 }, { ...VALID, confidence: 1 }]))).toHaveLength(2);
  });
});

describe("extractKbCandidates — injected-call contract (never throws)", () => {
  const input = { transcript: "[0] human: the limit is 120" };

  it("returns candidates on a valid call and logs kb_extraction_complete", async () => {
    const events: [string, Record<string, unknown> | undefined][] = [];
    const result = await extractKbCandidates(input, {
      call: async () => payload([VALID]),
      log: (e, d) => events.push([e, d]),
    });
    expect(result).toEqual([VALID]);
    expect(events.some(([e]) => e === "kb_extraction_complete")).toBe(true);
  });

  it("substitutes the transcript literally even when it contains $& patterns", async () => {
    let seen = "";
    await extractKbCandidates(
      { transcript: "[0] human: costs $& more" },
      { call: async (prompt) => ((seen = prompt), payload([])) , log: () => {} },
    );
    expect(seen).toContain("costs $& more");
  });

  it("returns null with reason api_error on a rejecting call", async () => {
    const events: [string, Record<string, unknown> | undefined][] = [];
    const result = await extractKbCandidates(input, {
      call: async () => { throw new Error("boom"); },
      log: (e, d) => events.push([e, d]),
    });
    expect(result).toBeNull();
    expect(events).toContainEqual(["kb_extraction_error", expect.objectContaining({ reason: "api_error" })]);
  });

  it("converts a synchronously-throwing injected call into api_error, not an escaping throw", async () => {
    const result = await extractKbCandidates(input, {
      call: () => { throw new Error("sync"); },
      log: () => {},
    });
    expect(result).toBeNull();
  });

  it("times out a hung call, aborts it, and returns null with reason timeout", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const events: [string, Record<string, unknown> | undefined][] = [];
    const pending = extractKbCandidates(input, {
      call: (_p, signal) =>
        new Promise<string>(() => { signal?.addEventListener("abort", () => { aborted = true; }); }),
      log: (e, d) => events.push([e, d]),
    });
    await vi.advanceTimersByTimeAsync(KB_EXTRACTOR_TIMEOUT_MS);
    expect(await pending).toBeNull();
    expect(aborted).toBe(true);
    expect(events).toContainEqual(["kb_extraction_error", expect.objectContaining({ reason: "timeout" })]);
  });

  it("returns null with reason malformed_json on unparseable output", async () => {
    const events: [string, Record<string, unknown> | undefined][] = [];
    expect(await extractKbCandidates(input, { call: async () => "{{nope", log: (e, d) => events.push([e, d]) })).toBeNull();
    expect(events).toContainEqual(["kb_extraction_error", expect.objectContaining({ reason: "malformed_json" })]);
  });

  it("returns null with reason invalid_shape on a wrong envelope", async () => {
    const events: [string, Record<string, unknown> | undefined][] = [];
    expect(await extractKbCandidates(input, { call: async () => '{"answers": []}', log: (e, d) => events.push([e, d]) })).toBeNull();
    expect(events).toContainEqual(["kb_extraction_error", expect.objectContaining({ reason: "invalid_shape" })]);
  });
});
