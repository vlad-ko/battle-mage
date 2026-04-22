import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @sentry/nextjs before importing the logger so flushLogs sees the
// mocked flush. `vi.hoisted` ensures the spy exists before vi.mock runs
// (vitest hoists vi.mock above top-level consts).
const { flushSpy } = vi.hoisted(() => ({ flushSpy: vi.fn().mockResolvedValue(true) }));
vi.mock("@sentry/nextjs", () => ({
  flush: (...args: unknown[]) => flushSpy(...args),
}));

import { log, createRequestLogger, flushLogs } from "./logger";

describe("log", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("outputs valid JSON", () => {
    log("test_event", { key: "value" });
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.event).toBe("test_event");
    expect(parsed.key).toBe("value");
  });

  it("includes timestamp", () => {
    log("test_event");
    const output = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.ts).toBeTypeOf("number");
    expect(parsed.ts).toBeGreaterThan(0);
  });

  it("works without data", () => {
    log("simple_event");
    const output = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.event).toBe("simple_event");
  });

  it("routes error events to console.error", () => {
    log("agent_api_error", { status: 500 });
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(parsed.event).toBe("agent_api_error");
    expect(parsed.status).toBe(500);
  });

  it("routes non-error events to console.log", () => {
    log("agent_complete", { rounds: 3 });
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

describe("createRequestLogger", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("includes requestId in all log calls", () => {
    const rlog = createRequestLogger();
    rlog("event_one", { data: "a" });
    rlog("event_two", { data: "b" });

    const output1 = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    const output2 = JSON.parse(consoleSpy.mock.calls[1][0] as string);

    expect(output1.requestId).toBeDefined();
    expect(output1.requestId).toBe(output2.requestId);
  });

  it("generates unique requestIds per logger", () => {
    const rlog1 = createRequestLogger();
    const rlog2 = createRequestLogger();

    rlog1("event_a");
    rlog2("event_b");

    const output1 = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    const output2 = JSON.parse(consoleSpy.mock.calls[1][0] as string);

    expect(output1.requestId).not.toBe(output2.requestId);
  });

  it("includes event name and data", () => {
    const rlog = createRequestLogger();
    rlog("my_event", { foo: "bar" });

    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(output.event).toBe("my_event");
    expect(output.foo).toBe("bar");
  });
});

describe("flushLogs", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    flushSpy.mockClear();
    flushSpy.mockResolvedValue(true);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("emits a turn_end event tagged with the flow name", async () => {
    const rlog = createRequestLogger();
    await flushLogs(rlog, "mention");

    expect(consoleSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(parsed.event).toBe("turn_end");
    expect(parsed.flow).toBe("mention");
    expect(parsed.requestId).toBeDefined();
  });

  it("explicitly drains the Sentry buffer via Sentry.flush before resolving", async () => {
    // Root fix for the after()-drop bug (#98): @sentry/nextjs auto-flushes
    // on response-end, which fires BEFORE after() callbacks run. Logs
    // emitted inside after() land in the buffer after the auto-flush
    // and rely on the 5s weight timer — which Vercel may not give us.
    // Calling Sentry.flush explicitly at the end of every after() body
    // forces a drain before the container freezes.
    const rlog = createRequestLogger();
    await flushLogs(rlog, "mention");
    expect(flushSpy).toHaveBeenCalled();
  });

  it("uses a 2000ms timeout — matches the SDK's own flushSafelyWithTimeout pattern", async () => {
    const rlog = createRequestLogger();
    await flushLogs(rlog, "mention");
    // The SDK's own vercelWaitUntil(flushSafelyWithTimeout()) uses 2000ms.
    // Pin that constant so a future refactor can't silently reduce it.
    expect(flushSpy).toHaveBeenCalledWith(2000);
  });

  it("flushes AFTER emitting turn_end so the turn_end itself is in the buffer", async () => {
    // Ordering matters: the turn_end log must be enqueued BEFORE flush
    // runs, otherwise we drain an empty buffer and the final event
    // still gets lost.
    const rlog = createRequestLogger();
    await flushLogs(rlog, "mention");
    // Both happened; the console.log (which enqueues the log) must have
    // been called before the flushSpy resolved.
    expect(consoleSpy).toHaveBeenCalled();
    expect(flushSpy).toHaveBeenCalled();
    // Vitest invocationCallOrder gives a monotonic id per call; lower = earlier.
    const logOrder = consoleSpy.mock.invocationCallOrder[0];
    const flushOrder = flushSpy.mock.invocationCallOrder[0];
    expect(logOrder).toBeLessThan(flushOrder);
  });

  it("does not throw when the logger itself throws", async () => {
    const throwing: import("./logger").LogFn = () => {
      throw new Error("logger broke");
    };
    // Must not reject — post-response flow depends on this invariant.
    await expect(flushLogs(throwing, "mention")).resolves.toBeUndefined();
  });

  it("does not throw when Sentry.flush rejects", async () => {
    // If Sentry transport is broken or times out, flushLogs must still
    // resolve — it's in a finally block of every after() callback.
    flushSpy.mockRejectedValueOnce(new Error("sentry transport blew up"));
    const rlog = createRequestLogger();
    await expect(flushLogs(rlog, "mention")).resolves.toBeUndefined();
  });
});
