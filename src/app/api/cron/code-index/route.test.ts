// ── Code-index cron route tests (#135) ───────────────────────────────
// Mirrors the sweep route harness: auth is exact-match Bearer and
// fail-closed; the tick's counters pass straight through as JSON; a
// throwing tick (contract violation — runCodeIndexTick is non-throwing
// by design) still gets Sentry + the #98 flushLogs tail-drop rule.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";

const h = vi.hoisted(() => ({
  runCodeIndexTickSpy: vi.fn(),
  rlogSpy: vi.fn(),
  flushLogsSpy: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock("@/lib/code-index", () => ({
  runCodeIndexTick: (...args: unknown[]) => h.runCodeIndexTickSpy(...args),
  CODE_INDEX_ROUTE_MAX_DURATION_SEC: 240,
}));

vi.mock("@/lib/logger", () => ({
  log: vi.fn(),
  createRequestLogger: () =>
    Object.assign(
      (event: string, data?: Record<string, unknown>) => h.rlogSpy(event, data),
      { requestId: "req-codeindex-1" },
    ),
  flushLogs: (...args: unknown[]) => h.flushLogsSpy(...args),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

// The route pulls isAuthorizedCronRequest from recovery.ts, which
// imports the real kv module — stub it so no Redis client is built.
vi.mock("@/lib/kv", () => ({ kv: {} }));

import { GET, maxDuration } from "./route";
import { CODE_INDEX_ROUTE_MAX_DURATION_SEC } from "@/lib/code-index";

function cronRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/cron/code-index", { headers });
}

beforeEach(() => {
  h.runCodeIndexTickSpy.mockReset();
  h.rlogSpy.mockClear();
  h.flushLogsSpy.mockClear();
  vi.mocked(Sentry.captureException).mockClear();
  process.env.CRON_SECRET = "s3cret";
});

describe("auth (fail-closed, mirrors isAuthorizedCronRequest contract)", () => {
  it("rejects a missing/mismatched Authorization header with 401 and never runs the tick", async () => {
    process.env.CRON_SECRET = "s3cret";
    const missing = await GET(cronRequest());
    expect(missing.status).toBe(401);

    const wrong = await GET(cronRequest({ authorization: "Bearer wrong" }));
    expect(wrong.status).toBe(401);

    // Unset secret + correct-looking header → still 401 (fail-closed).
    delete process.env.CRON_SECRET;
    const unset = await GET(cronRequest({ authorization: "Bearer s3cret" }));
    expect(unset.status).toBe(401);

    expect(h.runCodeIndexTickSpy).not.toHaveBeenCalled();
  });
});

describe("authorized tick", () => {
  it("authorized: runs the tick and returns its counters as JSON with 200", async () => {
    h.runCodeIndexTickSpy.mockResolvedValue({
      status: "complete",
      upserted: 3,
      deleted: 1,
      skipped: 0,
      remaining: 0,
    });
    const res = await GET(cronRequest({ authorization: "Bearer s3cret" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      status: "complete",
      upserted: 3,
      deleted: 1,
      skipped: 0,
      remaining: 0,
    });
  });

  it("a tick that throws (contract violation) → 500, Sentry captured, flushLogs still runs", async () => {
    const err = new Error("contract violation");
    h.runCodeIndexTickSpy.mockRejectedValue(err);
    const res = await GET(cronRequest({ authorization: "Bearer s3cret" }));
    expect(res.status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: { flow: "cron_code_index" } }),
    );
    expect(h.flushLogsSpy).toHaveBeenCalled();
  });
});

describe("route config", () => {
  it("exports maxDuration = CODE_INDEX_ROUTE_MAX_DURATION_SEC", () => {
    expect(maxDuration).toBe(240);
    expect(maxDuration).toBe(CODE_INDEX_ROUTE_MAX_DURATION_SEC);
  });
});
