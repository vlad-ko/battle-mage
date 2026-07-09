// ── Scenario runner: record/replay behavior evals (#137) ─────────────
// Drives REAL turn code (turn-runner → claude → tools → slack helpers)
// against a fully controlled world:
//
//   boundary                          | treatment
//   ----------------------------------+----------------------------------
//   @slack/web-api WebClient          | ALWAYS fake (I6) — slack.ts real
//   @anthropic-ai/sdk (3 singletons:  | cassette-backed: record live,
//     claude / effort-routing /       |   replay from disk
//     compaction)                     |
//   @/lib/github (semantic entries)   | cassette-backed; createIssue is
//                                     |   BLOCKLISTED at record → synthetic
//   @/lib/vector                      | fake store via the module's own
//                                     |   __setVectorStoreFactoryForTests
//   @/lib/kv                          | in-memory fake (scenario state)
//   @/lib/logger                      | captured into world.logEvents
//   @sentry/nextjs                    | no-op
//   Date                              | vi.useFakeTimers({toFake:["Date"]})
//                                     |   pinned to cassette.pinnedNow;
//                                     |   REAL timers stay live for the
//                                     |   throttle/timeout paths
//
// Invariants:
//   I5 — replay NEVER falls back to a live call (CassetteMissError)
//   I6 — Slack is always fake; createIssue never hits GitHub, its
//        recorded entry is marked "synthetic": true
//   I7 — RECORD=1 under CI throws (assertRecordAllowed)
//
// Determinism notes:
// - UPSTASH_VECTOR_REST_* is force-unset in BOTH modes so the vector
//   layer takes the same (degraded) path at record and replay time; the
//   fake store factory is still injected as defense-in-depth.
// - GITHUB_OWNER/GITHUB_REPO are pinned from cassette meta at replay so
//   prompt text (identity section, repo-context) hashes identically.
// - The en-US locale is asserted up front: prompt text interpolates
//   Number.prototype.toLocaleString(), which is ICU-locale-dependent.

import { vi, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeSlack, type FakeSlack, type FakeSlackCall } from "./fake-slack";
import { createFakeKV, type FakeKV } from "./fake-kv";
import {
  type Boundary,
  type Cassette,
  type CassetteEntry,
  type CassetteMatcher,
  createCassetteMatcher,
  requestHash,
  summarizeRequest,
  assertRecordAllowed,
  toPlainJson,
  errorFromCassetteEntry,
  RECORD_BLOCKLISTED_GITHUB_FNS,
  syntheticCreateIssueResponse,
} from "./cassette";
import {
  createAnthropicBoundary,
  type AnthropicClientLike,
} from "./anthropic-boundary";
import { assertThreadOnly, isSlackWrite } from "./contracts";

// Anchors that identify a proposal post (see src/lib/issue-batch.ts).
const PROPOSAL_ANCHORS = ["*Proposed Issue:*", "*Proposed Issues*"];

const CASSETTES_DIR = fileURLToPath(new URL("../cassettes/", import.meta.url));

/** Default record-time pin; stored in the cassette and re-pinned at replay. */
export const DEFAULT_PINNED_NOW = "2026-07-01T12:00:00.000Z";

// ── Public types ─────────────────────────────────────────────────────

export interface WorldGithubCall {
  fn: string;
  args: unknown[];
}

export interface WorldLogEvent {
  event: string;
  data?: Record<string, unknown>;
}

export interface ScenarioWorld {
  /** Every fake-Slack API call, in order. */
  slackCalls: FakeSlackCall[];
  /** Only the mutating Slack calls (postMessage/update/delete/…). */
  slackWrites(): FakeSlackCall[];
  /** Every semantic GitHub-boundary call, in order. */
  githubCalls: WorldGithubCall[];
  /** Scenario-local KV state. */
  kv: { keysWithPrefix(prefix: string): string[] };
  /** Every structured log event (module `log` + request-scoped rlog). */
  logEvents: WorldLogEvent[];
  /** Outcome of the most recent approveReaction step. */
  lastApproval?: { claimed: boolean };
}

export type ScenarioStep =
  | { kind: "mention"; user: string; text: string; inThread: boolean }
  | { kind: "followup"; user: string; text: string }
  | { kind: "approveReaction"; user: string }
  | { kind: "expect"; check: (world: ScenarioWorld) => void | Promise<void> };

/**
 * Record-mode response override for boundaries a live service can't
 * reliably produce (e.g. an exact-0.74-confidence classifier verdict or
 * a malformed payload). The matching request is NOT sent live; the
 * crafted response is recorded with `"synthetic": true` — the same
 * mechanism as the createIssue blocklist (I6).
 */
export interface RecordOverride {
  boundary: Boundary;
  when: (request: unknown) => boolean;
  response: unknown;
}

export interface ScenarioSpec {
  id: string;
  channel: string;
  botUserId: string;
  users?: Record<string, string>;
  thread: { user: string; text: string; ts: string }[];
  pinnedNow?: string;
  steps: ScenarioStep[];
  recordOverrides?: RecordOverride[];
}

// ── Helpers ──────────────────────────────────────────────────────────

function assertEnUsLocale(): void {
  const rendered = (1200).toLocaleString();
  if (rendered !== "1,200") {
    throw new Error(
      `Behavior evals require an en-US ICU locale: (1200).toLocaleString() ` +
        `returned "${rendered}" but "1,200" is needed for stable cassette ` +
        `hashes (the system prompt interpolates toLocaleString()). ` +
        `Re-run with LANG=en_US.UTF-8 (CI sets this; locally: ` +
        `LANG=en_US.UTF-8 npm run eval:behavior).`,
    );
  }
}

function cassettePath(scenarioId: string): string {
  return path.join(CASSETTES_DIR, `${scenarioId}.json`);
}

function loadCassette(scenarioId: string): Cassette {
  const file = cassettePath(scenarioId);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No cassette for scenario "${scenarioId}" (expected ${file}). ` +
        `Record it locally with real credentials:\n` +
        `  RECORD=1 npm run eval:behavior -- -t "${scenarioId}"`,
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as Cassette;
}

// The semantic GitHub boundary — every export of src/lib/github.ts.
const GITHUB_FNS = [
  "searchCode",
  "readFile",
  "listIssues",
  "getIssue",
  "createIssue",
  "getPullRequest",
  "listRecentCommits",
  "listRecentPRs",
  "getRepoTree",
  "getHeadSha",
] as const;

const MOCKED_MODULES = [
  "@slack/web-api",
  "@anthropic-ai/sdk",
  "@/lib/github",
  "@/lib/kv",
  "@/lib/logger",
  "@sentry/nextjs",
] as const;

// ── Runner ───────────────────────────────────────────────────────────

export async function runScenario(spec: ScenarioSpec): Promise<ScenarioWorld> {
  assertEnUsLocale();

  const mode: "record" | "replay" = process.env.RECORD === "1" ? "record" : "replay";
  let matcher: CassetteMatcher | null = null;
  const recordedEntries: CassetteEntry[] = [];
  let pinnedNow: string;

  if (mode === "record") {
    assertRecordAllowed(process.env);
    for (const required of ["ANTHROPIC_API_KEY", "GITHUB_PAT_BM", "GITHUB_OWNER", "GITHUB_REPO"]) {
      if (!process.env[required]) {
        throw new Error(
          `RECORD=1 needs ${required} — source your .env.local first:\n` +
            `  set -a; source .env.local; set +a; RECORD=1 npm run eval:behavior`,
        );
      }
    }
    pinnedNow = spec.pinnedNow ?? DEFAULT_PINNED_NOW;
  } else {
    const cassette = loadCassette(spec.id);
    matcher = createCassetteMatcher(spec.id, cassette.entries);
    pinnedNow = cassette.pinnedNow;
    // Pin the prompt-visible env to what the cassette was recorded with.
    process.env.GITHUB_OWNER = cassette.env.GITHUB_OWNER;
    process.env.GITHUB_REPO = cassette.env.GITHUB_REPO;
  }

  // Determinism: identical vector-layer path in both modes (degraded).
  delete process.env.UPSTASH_VECTOR_REST_URL;
  delete process.env.UPSTASH_VECTOR_REST_TOKEN;

  // Only Date is faked (pinned "now"); real timers keep the throttle and
  // classifier-timeout paths live.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(pinnedNow));

  // ── World state ────────────────────────────────────────────────────
  const fakeSlack: FakeSlack = createFakeSlack({
    botUserId: spec.botUserId,
    channel: spec.channel,
    thread: spec.thread,
    users: spec.users,
  });
  const fakeKV: FakeKV = createFakeKV();
  const githubCalls: WorldGithubCall[] = [];
  const logEvents: WorldLogEvent[] = [];

  const world: ScenarioWorld = {
    slackCalls: fakeSlack.calls,
    slackWrites: () => fakeSlack.calls.filter(isSlackWrite),
    githubCalls,
    kv: fakeKV,
    logEvents,
    lastApproval: undefined,
  };

  const pushEntry = (
    boundary: Boundary,
    request: unknown,
    outcome: {
      response?: unknown;
      error?: { name: string; message: string; status?: number };
      synthetic: boolean;
    },
  ): void => {
    recordedEntries.push({
      boundary,
      requestHash: requestHash(request),
      requestSummary: summarizeRequest(boundary, request),
      request,
      ...(outcome.error ? { error: outcome.error } : { response: outcome.response }),
      synthetic: outcome.synthetic,
    });
  };

  // ── Anthropic boundary (covers all three module singletons) ────────
  // Two-argument contract: production passes `{ signal }` as options —
  // see anthropic-boundary.ts. Matching is on params only; record mode
  // forwards options to the real SDK so timeout aborts hold.
  let realAnthropic: AnthropicClientLike | null = null;
  const anthropicCreate = createAnthropicBoundary({
    mode,
    matcher,
    overrides: spec.recordOverrides?.filter((o) => o.boundary === "anthropic"),
    pushEntry: (request, outcome) => pushEntry("anthropic", request, outcome),
    getRealClient: async () => {
      if (!realAnthropic) {
        const sdk = await vi.importActual<{ default: new () => AnthropicClientLike }>(
          "@anthropic-ai/sdk",
        );
        realAnthropic = new sdk.default();
      }
      return realAnthropic;
    },
  });

  // ── GitHub boundary (semantic entries; createIssue blocklisted) ────
  let syntheticIssueNumber = 9000;
  const githubDispatch = async (fn: string, args: unknown[]): Promise<unknown> => {
    githubCalls.push({ fn, args });
    const request = { fn, args: toPlainJson(args) };
    if (mode === "replay") {
      const entry = matcher!.match("github", request);
      if (entry.error) throw errorFromCassetteEntry(entry);
      return structuredClone(entry.response);
    }
    if (RECORD_BLOCKLISTED_GITHUB_FNS.has(fn)) {
      // I6: recording must NEVER write to the real repo.
      syntheticIssueNumber += 1;
      const response = syntheticCreateIssueResponse(syntheticIssueNumber, String(args[0]), {
        owner: process.env.GITHUB_OWNER,
        repo: process.env.GITHUB_REPO,
      });
      pushEntry("github", request, { response, synthetic: true });
      return structuredClone(response);
    }
    const actual = await vi.importActual<Record<string, (...a: unknown[]) => Promise<unknown>>>(
      "@/lib/github",
    );
    try {
      const response = toPlainJson(await actual[fn](...args));
      pushEntry("github", request, { response, synthetic: false });
      return response;
    } catch (err) {
      const e = err as Error & { status?: number };
      pushEntry("github", request, {
        error: { name: e.name, message: e.message, status: e.status },
        synthetic: false,
      });
      throw err;
    }
  };

  // ── Mock wiring (before ANY production import) ─────────────────────
  vi.resetModules();

  vi.doMock("@slack/web-api", () => ({
    WebClient: class {
      constructor() {
        // Constructor-return override: every `new WebClient(...)` in the
        // REAL slack.ts yields the scenario's fake client.
        return fakeSlack.client as unknown as object;
      }
    },
  }));

  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      messages = {
        create: (params: unknown, options?: unknown) => anthropicCreate(params, options),
      };
    },
  }));

  vi.doMock("@/lib/github", () => {
    const mod: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const fn of GITHUB_FNS) {
      mod[fn] = (...args: unknown[]) => githubDispatch(fn, args);
    }
    return mod;
  });

  vi.doMock("@/lib/kv", () => ({
    kv: fakeKV.kv,
    keyPrefix: (key: string) => {
      const idx = key.indexOf(":");
      return idx === -1 ? key : key.slice(0, idx);
    },
  }));

  vi.doMock("@/lib/logger", () => {
    const capture = (event: string, data?: Record<string, unknown>) => {
      logEvents.push({ event, data });
    };
    return {
      log: capture,
      createRequestLogger: () =>
        Object.assign(
          (event: string, data?: Record<string, unknown>) => capture(event, data),
          { requestId: "scenario" },
        ),
      flushLogs: async (rlog: (e: string, d?: Record<string, unknown>) => void, flow: string) => {
        rlog("turn_end", { flow });
      },
    };
  });

  vi.doMock("@sentry/nextjs", () => ({
    captureException: () => "",
    captureMessage: () => "",
    addBreadcrumb: () => {},
    setTag: () => {},
    setContext: () => {},
    withScope: (cb: (scope: unknown) => void) => cb({}),
    flush: async () => true,
  }));

  const rlog = Object.assign(
    (event: string, data?: Record<string, unknown>) => {
      logEvents.push({ event, data });
    },
    { requestId: "scenario" },
  );

  // Resolve the proposal message's first ts: primary source is the
  // canonical KV key written when the batch was persisted (survives as a
  // remembered value across the del-claim, so a double-approve still
  // targets the same message); fallback is an anchor scan of the thread.
  let rememberedFirstTs: string | undefined;
  const batchKeyPrefix = `pending-issue-batch:${spec.channel}:`;
  const refreshProposalFirstTs = (): void => {
    const keys = fakeKV.keysWithPrefix(batchKeyPrefix);
    if (keys.length > 0) {
      rememberedFirstTs = keys[keys.length - 1].slice(batchKeyPrefix.length);
    }
  };
  const resolveProposalFirstTs = (): string => {
    if (rememberedFirstTs) return rememberedFirstTs;
    const proposal = fakeSlack
      .threadMessages()
      .filter((m) => PROPOSAL_ANCHORS.some((a) => m.text.includes(a)))
      .at(-1);
    if (!proposal) {
      throw new Error(
        `approveReaction: no proposal post found in scenario "${spec.id}" — ` +
          `did the agent actually propose an issue this turn?`,
      );
    }
    return proposal.ts;
  };

  try {
    // Real production graph, imported fresh under the mocks above.
    const turnRunner = await import("@/lib/turn-runner");
    const vector = await import("@/lib/vector");
    // Defense-in-depth: even if vector env leaks in, no real SDK client.
    vector.__setVectorStoreFactoryForTests(() => ({
      upsert: async () => {},
      query: async () => [],
      delete: async () => {},
      deleteNamespace: async () => {},
    }));

    const threadTs = fakeSlack.rootTs;

    const runSteps = async (): Promise<void> => {
      for (const step of spec.steps) {
        if (step.kind === "mention") {
          await turnRunner.runMentionTurn({
            channel: spec.channel,
            threadTs,
            user: step.user,
            text: step.text,
            inThread: step.inThread,
            rlog,
          });
          refreshProposalFirstTs();
        } else if (step.kind === "followup") {
          fakeSlack.appendUserMessage(step.user, step.text);
          await turnRunner.runFollowupTurn({
            channel: spec.channel,
            threadTs,
            user: step.user,
            text: step.text,
            rlog,
          });
          refreshProposalFirstTs();
        } else if (step.kind === "approveReaction") {
          // The route's reaction parsing is unit-tested elsewhere — the
          // behavioral contract starts at the batch-claim protocol.
          world.lastApproval = await turnRunner.executeBatchCreation(
            spec.channel,
            threadTs,
            resolveProposalFirstTs(),
            step.user,
            "reaction",
            rlog,
          );
        } else {
          await step.check(world);
        }
      }
    };

    try {
      await runSteps();
    } catch (err) {
      // A failed step usually means the TURN diverged (error reply,
      // missing proposal, unexpected decline). The captured log events
      // are the only trace — surface the tail before rethrowing.
      const tail = logEvents
        .slice(-12)
        .map((e) => `  ${e.event} ${JSON.stringify(e.data ?? {}).slice(0, 200)}`)
        .join("\n");
      console.error(
        `[behavior-eval] scenario "${spec.id}" step failed; last log events:\n${tail}`,
      );
      throw err;
    }

    // Auto-applied global contract: the bot never posts at channel root.
    const threadOnly = assertThreadOnly(world.slackCalls);
    expect(threadOnly.pass, threadOnly.detail).toBe(true);

    if (mode === "record") {
      const cassette: Cassette = {
        version: 1,
        scenarioId: spec.id,
        pinnedNow,
        env: {
          GITHUB_OWNER: process.env.GITHUB_OWNER!,
          GITHUB_REPO: process.env.GITHUB_REPO!,
        },
        entries: recordedEntries,
      };
      fs.mkdirSync(CASSETTES_DIR, { recursive: true });
      fs.writeFileSync(cassettePath(spec.id), JSON.stringify(cassette, null, 2) + "\n");
    }

    return world;
  } finally {
    vi.useRealTimers();
    for (const mod of MOCKED_MODULES) vi.doUnmock(mod);
    try {
      const vector = await import("@/lib/vector");
      vector.__setVectorStoreFactoryForTests(null);
    } catch {
      // Best-effort seam reset.
    }
    vi.resetModules();
  }
}
