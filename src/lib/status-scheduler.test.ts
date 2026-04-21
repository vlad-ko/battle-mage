import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createStatusScheduler,
  DEFAULT_STATUS_DEBOUNCE_MS,
  DEFAULT_STATUS_ROTATION_MS,
  DEFAULT_STATUS_ROTATION_TEXT,
} from "./status-scheduler";

describe("createStatusScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const config = {
    debounceMs: 1000,
    rotationMs: 30_000,
    rotationText: "still working…",
  };

  it("fires fn with the scheduled text after the debounce interval", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const scheduler = createStatusScheduler(fn, config);

    scheduler.schedule("searching…");
    // First schedule fires immediately (no prior flush).
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledWith("searching…");
  });

  it("coalesces rapid schedule calls into one fn call with the latest text", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const scheduler = createStatusScheduler(fn, config);

    scheduler.schedule("step 1");
    // Fire the first immediate schedule.
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // Burst of updates inside the debounce window coalesces.
    scheduler.schedule("step 2");
    scheduler.schedule("step 3");
    scheduler.schedule("step 4");

    // Not yet — still inside debounce window since last fire.
    await vi.advanceTimersByTimeAsync(500);
    expect(fn).toHaveBeenCalledTimes(1);

    // After full debounce window: exactly one more call, with the LATEST text.
    await vi.advanceTimersByTimeAsync(600);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("step 4");
  });

  it("fires rotationText after rotationMs of silence", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const scheduler = createStatusScheduler(fn, config);

    scheduler.schedule("searching…");
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // Fast-forward past the rotation interval; no new schedules.
    await vi.advanceTimersByTimeAsync(config.rotationMs + 100);

    // Rotation tick fires the rotationText.
    expect(fn).toHaveBeenCalledWith("still working…");
    expect(fn.mock.calls.some((c) => c[0] === "still working…")).toBe(true);
  });

  it("does not fire rotation if schedule() is called within the rotation window", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const scheduler = createStatusScheduler(fn, config);

    scheduler.schedule("A");
    await vi.advanceTimersByTimeAsync(0);
    // Trigger another schedule before rotation would have fired.
    await vi.advanceTimersByTimeAsync(20_000);
    scheduler.schedule("B");
    await vi.advanceTimersByTimeAsync(1100);

    // Two normal calls so far; no rotation yet.
    expect(fn.mock.calls.filter((c) => c[0] === "still working…")).toHaveLength(0);
    expect(fn).toHaveBeenCalledWith("A");
    expect(fn).toHaveBeenCalledWith("B");
  });

  it("re-arms rotation after firing so long idle periods get multiple ticks", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const scheduler = createStatusScheduler(fn, {
      ...config,
      rotationMs: 10_000,
    });

    scheduler.schedule("initial");
    await vi.advanceTimersByTimeAsync(0);

    // Wait out two full rotation cycles with no schedule() calls.
    await vi.advanceTimersByTimeAsync(10_100);
    await vi.advanceTimersByTimeAsync(10_100);

    const rotationCalls = fn.mock.calls.filter((c) => c[0] === "still working…");
    expect(rotationCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("flush() forces the pending update and stops rotation", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const scheduler = createStatusScheduler(fn, config);

    scheduler.schedule("first");
    await vi.advanceTimersByTimeAsync(0);
    scheduler.schedule("pending");

    // Before flush: only the initial fire.
    expect(fn).toHaveBeenCalledTimes(1);

    const flushPromise = scheduler.flush();
    await vi.runAllTimersAsync();
    await flushPromise;

    // flush forced the pending update through.
    expect(fn).toHaveBeenCalledWith("pending");

    // No rotation after flush even if we wait indefinitely.
    fn.mockClear();
    await vi.advanceTimersByTimeAsync(config.rotationMs + 1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel() drops pending text AND stops rotation", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const scheduler = createStatusScheduler(fn, config);

    scheduler.schedule("first");
    await vi.advanceTimersByTimeAsync(0);
    scheduler.schedule("should be dropped");

    const cancelPromise = scheduler.cancel();
    await vi.runAllTimersAsync();
    await cancelPromise;

    // Only the initial fire; the dropped text never fired.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalledWith("should be dropped");

    // No rotation either.
    fn.mockClear();
    await vi.advanceTimersByTimeAsync(config.rotationMs + 1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("swallows fn errors so a failing chat.update doesn't crash the agent", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("slack_rate_limited"));
    const scheduler = createStatusScheduler(fn, config);

    scheduler.schedule("doomed");
    // Drive the immediate fire + let its rejection propagate through the
    // throttle's internal catch (must not bubble). Use cancel() to stop
    // the rotation timer — otherwise runAllTimers would loop forever
    // because rotation re-arms itself.
    await vi.advanceTimersByTimeAsync(100);
    await scheduler.cancel();

    expect(fn).toHaveBeenCalled();
  });

  it("rotationMs = 0 disables rotation entirely", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const scheduler = createStatusScheduler(fn, { ...config, rotationMs: 0 });

    scheduler.schedule("once");
    await vi.advanceTimersByTimeAsync(0);
    fn.mockClear();

    // No rotation should fire no matter how long we wait.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("default constants", () => {
  it("DEFAULT_STATUS_DEBOUNCE_MS is in the 1-2s range", () => {
    // Junior's pattern: 1-2 second debounce keeps updates readable
    // while staying under Slack's 1/sec rate limit.
    expect(DEFAULT_STATUS_DEBOUNCE_MS).toBeGreaterThanOrEqual(1000);
    expect(DEFAULT_STATUS_DEBOUNCE_MS).toBeLessThanOrEqual(2000);
  });

  it("DEFAULT_STATUS_ROTATION_MS is in the 20-60s range", () => {
    // Slack auto-dims inactive messages around 30-60s; rotate within that.
    expect(DEFAULT_STATUS_ROTATION_MS).toBeGreaterThanOrEqual(20_000);
    expect(DEFAULT_STATUS_ROTATION_MS).toBeLessThanOrEqual(60_000);
  });

  it("DEFAULT_STATUS_ROTATION_TEXT is a non-empty string", () => {
    expect(DEFAULT_STATUS_ROTATION_TEXT).toBeTypeOf("string");
    expect(DEFAULT_STATUS_ROTATION_TEXT.length).toBeGreaterThan(0);
  });
});
