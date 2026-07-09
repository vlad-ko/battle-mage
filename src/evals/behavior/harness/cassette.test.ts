import { describe, it, expect } from "vitest";
import {
  canonicalJson,
  requestHash,
  stripAnthropicVolatile,
  createCassetteMatcher,
  CassetteMissError,
} from "./cassette";

describe("canonicalJson", () => {
  it("sorts object keys recursively so hash input is order-independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it("preserves array element order (messages order is semantic)", () => {
    expect(canonicalJson({ m: [{ z: 1 }, { a: 2 }] })).toBe(
      '{"m":[{"z":1},{"a":2}]}',
    );
  });

  it("is stable for unicode and null values", () => {
    expect(canonicalJson({ t: "réf 🎫", n: null })).toBe('{"n":null,"t":"réf 🎫"}');
  });
});

describe("requestHash", () => {
  it("returns identical sha256-prefixed hashes for key-permuted equal requests", () => {
    const h1 = requestHash({ model: "claude-sonnet-4-6", max_tokens: 4096 });
    const h2 = requestHash({ max_tokens: 4096, model: "claude-sonnet-4-6" });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("differs when any value changes", () => {
    expect(requestHash({ q: "a" })).not.toBe(requestHash({ q: "b" }));
  });
});

describe("stripAnthropicVolatile", () => {
  const recorded = {
    id: "msg_01XYZ",
    _request_id: "req_abc",
    content: [
      { type: "tool_use", id: "toolu_stable_1", name: "create_issue", input: { title: "T" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 50 },
  };

  it("replaces the message id with the stable sentinel", () => {
    expect(stripAnthropicVolatile(recorded).id).toBe("msg_cassette");
  });

  it("drops _request_id", () => {
    expect("_request_id" in stripAnthropicVolatile(recorded)).toBe(false);
  });

  it("preserves tool_use block ids (they are echoed into the next request hash)", () => {
    const out = stripAnthropicVolatile(recorded);
    expect(out.content[0].id).toBe("toolu_stable_1");
  });

  it("preserves content, stop_reason and usage verbatim", () => {
    const out = stripAnthropicVolatile(recorded);
    expect(out.stop_reason).toBe("tool_use");
    expect(out.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
  });
});

describe("createCassetteMatcher (replay)", () => {
  const entry = (hash: string, marker: number) => ({
    boundary: "github" as const,
    requestHash: hash,
    requestSummary: { fn: "readFile" },
    request: { fn: "readFile", args: ["CLAUDE.md"] },
    response: { content: `v${marker}` },
    synthetic: false,
  });

  it("returns entries for an identical repeated request in recorded (FIFO) order", () => {
    const h = requestHash({ fn: "readFile", args: ["CLAUDE.md"] });
    const m = createCassetteMatcher("scenario-x", [entry(h, 1), entry(h, 2)]);
    expect(m.match("github", { fn: "readFile", args: ["CLAUDE.md"] }).response).toEqual({ content: "v1" });
    expect(m.match("github", { fn: "readFile", args: ["CLAUDE.md"] }).response).toEqual({ content: "v2" });
  });

  it("throws CassetteMissError on an unrecorded request — never a live fallback", () => {
    const m = createCassetteMatcher("scenario-x", []);
    expect(() => m.match("github", { fn: "readFile", args: ["nope.md"] })).toThrow(CassetteMissError);
  });

  it("throws when a recorded hash's FIFO queue is exhausted (third call, two entries)", () => {
    const h = requestHash({ fn: "readFile", args: ["CLAUDE.md"] });
    const m = createCassetteMatcher("scenario-x", [entry(h, 1)]);
    m.match("github", { fn: "readFile", args: ["CLAUDE.md"] });
    expect(() => m.match("github", { fn: "readFile", args: ["CLAUDE.md"] })).toThrow(CassetteMissError);
  });

  it("miss error message carries scenario id, hash, and the re-record command", () => {
    const m = createCassetteMatcher("issue-approval-reaction", []);
    try {
      m.match("anthropic", { model: "claude-sonnet-4-6", messages: [] });
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("issue-approval-reaction");
      expect(msg).toContain("sha256:");
      expect(msg).toContain('RECORD=1 npm run eval:behavior -- -t "issue-approval-reaction"');
    }
  });
});

describe("record-mode guard", () => {
  it("assertRecordAllowed throws when RECORD=1 and CI are both set", async () => {
    const { assertRecordAllowed } = await import("./cassette");
    expect(() => assertRecordAllowed({ RECORD: "1", CI: "true" })).toThrow(/refus/i);
  });

  it("allows record locally (RECORD=1, no CI)", async () => {
    const { assertRecordAllowed } = await import("./cassette");
    expect(() => assertRecordAllowed({ RECORD: "1" })).not.toThrow();
  });
});
