import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log, createRequestLogger } from "./logger";

describe("log", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
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
