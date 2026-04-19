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

  it("serializes fn() — never runs concurrently even when fn is slower than the interval", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const fn = vi.fn(async (_text: string) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 2000)); // slow fn
      inflight--;
    });
    const throttle = createThrottledUpdater(fn, 1000);

    // t=0: fires immediately, fn("a") starts a 2000ms call
    throttle.update("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(inflight).toBe(1);

    // t=1500: interval has elapsed but "a" is still in flight — must NOT start "b"
    await vi.advanceTimersByTimeAsync(1500);
    throttle.update("b");
    await vi.advanceTimersByTimeAsync(0);
    expect(
      maxInflight,
      "second fn() call started before first finished — concurrent writes",
    ).toBe(1);

    // Let "a" finish; "b" may then start (serialized)
    await vi.advanceTimersByTimeAsync(2500);
    expect(maxInflight).toBe(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("flush() awaits an in-flight fn() before returning", async () => {
    let completed = false;
    const fn = vi.fn(async (_text: string) => {
      await new Promise((r) => setTimeout(r, 2000));
      completed = true;
    });
    const throttle = createThrottledUpdater(fn, 1000);

    throttle.update("x");
    await vi.advanceTimersByTimeAsync(0); // fn starts
    expect(completed).toBe(false);

    const flushDone = vi.fn();
    const flushPromise = throttle.flush().then(flushDone);

    // Before fn finishes: flush should NOT have resolved
    await vi.advanceTimersByTimeAsync(1000);
    expect(completed).toBe(false);
    expect(flushDone).not.toHaveBeenCalled();

    // Let fn finish
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromise;
    expect(completed).toBe(true);
    expect(flushDone).toHaveBeenCalled();
  });

  it("cancel() drops pending text and clears the timer — no further fn() calls", async () => {
    const fn = vi.fn(async (_text: string) => {});
    const throttle = createThrottledUpdater(fn, 1000);

    // First update fires immediately
    throttle.update("first");
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // Queue a deferred update, then cancel — the timer must not fire
    throttle.update("pending");
    await throttle.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).toHaveBeenCalledTimes(1); // still just "first"

    // After cancel, update() still works for fresh calls
    throttle.update("after-cancel");
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(2, "after-cancel");
  });

  it("cancel() awaits an in-flight fn() — no stale writes can land after it resolves", async () => {
    // Scenario: a slow streaming edit is still running when onProgress fires
    // and calls cancel() before writing an emoji update. cancel() must block
    // until the streamed write is done, otherwise the emoji could be
    // overwritten by the delayed Slack response.
    let completed = false;
    const fn = vi.fn(async (_text: string) => {
      await new Promise((r) => setTimeout(r, 2000));
      completed = true;
    });
    const throttle = createThrottledUpdater(fn, 1000);

    throttle.update("streamed"); // starts fn, takes 2000ms
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);

    // cancel() must NOT resolve before fn completes
    const cancelDone = vi.fn();
    const cancelPromise = throttle.cancel().then(cancelDone);

    await vi.advanceTimersByTimeAsync(1000);
    expect(completed).toBe(false);
    expect(cancelDone).not.toHaveBeenCalled();

    // Let fn finish
    await vi.advanceTimersByTimeAsync(1000);
    await cancelPromise;
    expect(completed).toBe(true);
    expect(cancelDone).toHaveBeenCalled();
  });
});
