import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log, createRequestLogger } from "./logger";

// Mock Sentry so we can assert the logger dual-emits without touching
// the real SDK (which would be a no-op anyway without a DSN).
const sentryLoggerInfo = vi.fn();
const sentryLoggerError = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  logger: {
    info: (...args: unknown[]) => sentryLoggerInfo(...args),
    error: (...args: unknown[]) => sentryLoggerError(...args),
    // template tag used by Sentry v10 `logger.info\`...\`` calls — we
    // don't use it but the SDK expects it to exist as a property.
    fmt: (strings: TemplateStringsArray, ..._values: unknown[]) => strings.join(""),
  },
}));

describe("log", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sentryLoggerInfo.mockClear();
    sentryLoggerError.mockClear();
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

  it("dual-emits to Sentry.logger.info for non-error events", () => {
    log("agent_complete", { rounds: 3, input_tokens: 1000 });
    expect(sentryLoggerInfo).toHaveBeenCalledOnce();
    // First arg is the event name; second is a context object with the data
    const [eventArg, ctxArg] = sentryLoggerInfo.mock.calls[0];
    expect(eventArg).toBe("agent_complete");
    expect(ctxArg).toMatchObject({ rounds: 3, input_tokens: 1000 });
    // Sentry.logger.error must NOT be called for non-error events
    expect(sentryLoggerError).not.toHaveBeenCalled();
  });

  it("dual-emits to Sentry.logger.error for error events", () => {
    log("agent_api_error", { status: 500 });
    expect(sentryLoggerError).toHaveBeenCalledOnce();
    expect(sentryLoggerInfo).not.toHaveBeenCalled();
    const [eventArg, ctxArg] = sentryLoggerError.mock.calls[0];
    expect(eventArg).toBe("agent_api_error");
    expect(ctxArg).toMatchObject({ status: 500 });
  });

  it("dual-emits even when data is undefined", () => {
    log("bare_event");
    expect(sentryLoggerInfo).toHaveBeenCalledWith("bare_event", expect.any(Object));
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
