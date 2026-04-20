import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  it("yields the event loop via setImmediate before resolving", async () => {
    // The `after()`-drop fix relies on flushLogs scheduling at least one
    // setImmediate tick between the turn_end log and the promise
    // resolution, so stdout can drain before Vercel hibernates the
    // container. A regression that removes the `setImmediate` yield
    // (e.g. switching to a sync return) must fail this test.
    const spy = vi.spyOn(global, "setImmediate");
    try {
      const rlog = createRequestLogger();
      await flushLogs(rlog, "mention");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not throw when the logger itself throws", async () => {
    const throwing: import("./logger").RequestLogger = () => {
      throw new Error("logger broke");
    };
    // Must not reject — post-response flow depends on this invariant.
    await expect(flushLogs(throwing, "mention")).resolves.toBeUndefined();
  });
});
