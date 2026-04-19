import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createThrottledUpdater } from "./slack-throttle";

describe("createThrottledUpdater", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the first update immediately", async () => {
    const fn = vi.fn(async (_text: string) => {});
    const throttle = createThrottledUpdater(fn, 1000);

    throttle.update("first");
    await vi.advanceTimersByTimeAsync(0);

    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith("first");
  });

  it("coalesces rapid updates within the min interval into one deferred call with the latest text", async () => {
    const fn = vi.fn(async (_text: string) => {});
    const throttle = createThrottledUpdater(fn, 1000);

    throttle.update("a"); // immediate
    await vi.advanceTimersByTimeAsync(0);
    throttle.update("b"); // deferred
    throttle.update("c"); // deferred, replaces b
    throttle.update("d"); // deferred, replaces c

    // Before the interval elapses, still only 1 call
    expect(fn).toHaveBeenCalledTimes(1);

    // After interval: the deferred flush fires with the LATEST text
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(2, "d");
  });

  it("fires immediately if enough time has elapsed since the last flush", async () => {
    const fn = vi.fn(async (_text: string) => {});
    const throttle = createThrottledUpdater(fn, 1000);

    throttle.update("a");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1500); // well past interval
    throttle.update("b");
    await vi.advanceTimersByTimeAsync(0);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(2, "b");
  });

  it("flush() forces the pending update immediately and clears the timer", async () => {
    const fn = vi.fn(async (_text: string) => {});
    const throttle = createThrottledUpdater(fn, 1000);

    throttle.update("first"); // fires immediately
    await vi.advanceTimersByTimeAsync(0);
    throttle.update("second"); // deferred
    expect(fn).toHaveBeenCalledTimes(1);

    await throttle.flush();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(2, "second");

    // After flush, a later update that's within the interval still defers correctly
    throttle.update("third");
    expect(fn).toHaveBeenCalledTimes(2); // not yet
  });

  it("flush() is a no-op when nothing is pending", async () => {
    const fn = vi.fn(async (_text: string) => {});
    const throttle = createThrottledUpdater(fn, 1000);

    await throttle.flush();
    expect(fn).not.toHaveBeenCalled();

    throttle.update("x");
    await vi.advanceTimersByTimeAsync(0);
    await throttle.flush();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("swallows errors from the update function without breaking throttling", async () => {
    const fn = vi.fn(async (_text: string) => {
      throw new Error("slack rate limit");
    });
    const throttle = createThrottledUpdater(fn, 1000);

    throttle.update("boom");
    await vi.advanceTimersByTimeAsync(0);

    // Subsequent update should still be accepted
    await vi.advanceTimersByTimeAsync(1500);
    throttle.update("after");
    await vi.advanceTimersByTimeAsync(0);

    expect(fn).toHaveBeenCalledTimes(2);
  });
});
