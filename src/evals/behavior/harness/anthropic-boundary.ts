// ── Anthropic boundary handler (#137, PR #140 review) ────────────────
// The cassette-backed stand-in for `anthropic.messages.create` used by
// the scenario runner. Production code calls it with TWO arguments —
// `create(params, { signal })` — the classifier timeout (#126) aborts
// through the second one. Contract:
//
// - hash/match on `params` ONLY (an AbortSignal is per-call and
//   non-serializable; cassettes stay byte-compatible),
// - in RECORD mode forward `options` to the real SDK verbatim so
//   cancellation semantics hold while recording (a timed-out classifier
//   call must actually abort, not keep running and billing).

import {
  type CassetteMatcher,
  type AnthropicMessageLike,
  stripAnthropicVolatile,
  toPlainJson,
  errorFromCassetteEntry,
} from "./cassette";

export interface AnthropicClientLike {
  messages: { create: (params: never, options?: unknown) => Promise<unknown> };
}

/** Record-mode synthetic override (already filtered to this boundary). */
export interface AnthropicOverride {
  when: (request: unknown) => boolean;
  response: unknown;
}

export interface AnthropicBoundaryOutcome {
  response?: unknown;
  error?: { name: string; message: string; status?: number };
  synthetic: boolean;
}

export interface AnthropicBoundaryDeps {
  mode: "record" | "replay";
  /** Required in replay mode. */
  matcher?: CassetteMatcher | null;
  /** Record-mode synthetic response overrides. */
  overrides?: AnthropicOverride[];
  /** Record-mode cassette sink. */
  pushEntry?: (request: unknown, outcome: AnthropicBoundaryOutcome) => void;
  /** Lazy real-SDK client — record mode only, never called for overrides. */
  getRealClient?: () => Promise<AnthropicClientLike>;
}

export type AnthropicBoundary = (
  params: unknown,
  options?: unknown,
) => Promise<unknown>;

export function createAnthropicBoundary(deps: AnthropicBoundaryDeps): AnthropicBoundary {
  return async (params: unknown, options?: unknown): Promise<unknown> => {
    // Hash/match input: params only — never the per-call options.
    const request = toPlainJson(params);

    if (deps.mode === "replay") {
      const entry = deps.matcher!.match("anthropic", request);
      if (entry.error) throw errorFromCassetteEntry(entry);
      return structuredClone(entry.response);
    }

    const override = deps.overrides?.find((o) => o.when(request));
    if (override) {
      const response = stripAnthropicVolatile(
        toPlainJson(override.response) as AnthropicMessageLike,
      );
      deps.pushEntry?.(request, { response, synthetic: true });
      return structuredClone(response);
    }

    const client = await deps.getRealClient!();
    try {
      // Forward options verbatim — abort signals must reach the SDK.
      const raw = await client.messages.create(params as never, options);
      const response = stripAnthropicVolatile(toPlainJson(raw) as AnthropicMessageLike);
      deps.pushEntry?.(request, { response, synthetic: false });
      return structuredClone(response);
    } catch (err) {
      const e = err as Error & { status?: number };
      deps.pushEntry?.(request, {
        error: { name: e.name, message: e.message, status: e.status },
        synthetic: false,
      });
      throw err;
    }
  };
}
