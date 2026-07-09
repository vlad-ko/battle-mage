import { describe, it, expect } from "vitest";
import { createAnthropicBoundary } from "./anthropic-boundary";
import { requestHash, createCassetteMatcher, type CassetteEntry } from "./cassette";

// Qodo finding #1 on PR #140: production calls
// `anthropic.messages.create(params, { signal })` — the classifier
// timeout (#126) aborts via that second argument. The boundary must
// accept and forward `options` (record mode: real cancellation holds;
// a timed-out classifier call must actually abort, not keep billing)
// while hashing/matching on `params` ONLY (cassette compatibility —
// an AbortSignal is per-call and non-serializable).

const params = {
  model: "claude-haiku-4-5-20251001",
  max_tokens: 256,
  messages: [{ role: "user", content: "classify this" }],
};

const entryFor = (response: unknown): CassetteEntry => ({
  boundary: "anthropic",
  requestHash: requestHash(params),
  requestSummary: { model: params.model },
  request: params,
  response,
  synthetic: false,
});

describe("createAnthropicBoundary", () => {
  it("replay: a per-call abort signal never affects the params-only hash match", async () => {
    const response = { id: "msg_cassette", content: [{ type: "text", text: "{}" }] };
    const boundary = createAnthropicBoundary({
      mode: "replay",
      matcher: createCassetteMatcher("scenario-x", [entryFor(response)]),
    });
    const controller = new AbortController();
    const out = await boundary(params, { signal: controller.signal });
    expect(out).toEqual(response);
  });

  it("record: forwards the options argument (same object) to the real SDK call", async () => {
    const seen: { params?: unknown; options?: unknown } = {};
    const boundary = createAnthropicBoundary({
      mode: "record",
      pushEntry: () => {},
      getRealClient: async () => ({
        messages: {
          create: async (p: never, o?: unknown) => {
            seen.params = p;
            seen.options = o;
            return {
              id: "msg_live_01",
              _request_id: "req_abc",
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          },
        },
      }),
    });
    const options = { signal: new AbortController().signal };
    await boundary(params, options);
    expect(seen.options).toBe(options);
  });

  it("record: the recorded entry captures params only — options never enter the cassette", async () => {
    const recorded: { request: unknown; response?: unknown }[] = [];
    const boundary = createAnthropicBoundary({
      mode: "record",
      pushEntry: (request, outcome) => recorded.push({ request, response: outcome.response }),
      getRealClient: async () => ({
        messages: {
          create: async () => ({
            id: "msg_live_02",
            _request_id: "req_def",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        },
      }),
    });
    await boundary(params, { signal: new AbortController().signal });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].request).toEqual(params);
    // Volatile fields stripped on the way into the cassette.
    expect((recorded[0].response as { id: string }).id).toBe("msg_cassette");
    expect("_request_id" in (recorded[0].response as object)).toBe(false);
  });

  it("record: a synthetic override matches on params only and never touches the client", async () => {
    let clientTouched = false;
    const recorded: { synthetic: boolean }[] = [];
    const boundary = createAnthropicBoundary({
      mode: "record",
      overrides: [
        {
          when: (req) => (req as { model?: string }).model?.startsWith("claude-haiku") ?? false,
          response: {
            id: "msg_synthetic",
            content: [{ type: "text", text: "{}" }],
            stop_reason: "end_turn",
            usage: {},
          },
        },
      ],
      pushEntry: (_request, outcome) => recorded.push({ synthetic: outcome.synthetic }),
      getRealClient: async () => {
        clientTouched = true;
        throw new Error("real client must not be constructed for an override");
      },
    });
    const out = await boundary(params, { signal: new AbortController().signal });
    expect(clientTouched).toBe(false);
    expect((out as { id: string }).id).toBe("msg_cassette");
    expect(recorded).toEqual([{ synthetic: true }]);
  });
});
