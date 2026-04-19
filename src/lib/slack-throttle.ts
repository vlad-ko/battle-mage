export interface ThrottledUpdater {
  update(text: string): void;
  flush(): Promise<void>;
  cancel(): void;
}

// Coalesces rapid update() calls into at most one flush per minIntervalMs,
// and serializes flushes so fn() never runs concurrently — important when
// fn is an async Slack chat.update that can exceed the interval under rate
// limiting.
//
// - First update fires immediately (if not busy).
// - Subsequent updates within the interval collapse to the LATEST text.
// - If fn takes longer than the interval, further updates wait for it;
//   the next fn() call is scheduled onto the in-flight chain.
// - flush() awaits any in-flight fn() AND any pending text, returning only
//   when Slack has observed the final state.
// - cancel() drops pending text and clears the timer without firing —
//   used by the route when emoji progress takes over from streamed text.
export function createThrottledUpdater(
  fn: (text: string) => Promise<void>,
  minIntervalMs: number,
  now: () => number = Date.now,
): ThrottledUpdater {
  let lastFlushAt = -Infinity;
  let pendingText: string | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;

  function fireNow(): void {
    if (pendingText === null || busy) return;
    const text = pendingText;
    pendingText = null;
    busy = true;
    inFlight = (async () => {
      try {
        await fn(text);
      } catch {
        // Swallow — transient Slack errors (rate limit, deleted message)
        // must not break the agent loop.
      }
      busy = false;
      lastFlushAt = now();
      // A later update() may have arrived while fn() was running;
      // re-check schedule so it gets picked up.
      maybeSchedule();
    })();
  }

  function maybeSchedule(): void {
    if (pendingText === null || busy || timer) return;
    const elapsed = now() - lastFlushAt;
    if (elapsed >= minIntervalMs) {
      fireNow();
      return;
    }
    const delay = Math.max(0, minIntervalMs - elapsed);
    timer = setTimeout(() => {
      timer = null;
      fireNow();
    }, delay);
  }

  return {
    update(text: string): void {
      pendingText = text;
      maybeSchedule();
    },
    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Drain any currently running fn() call first.
      await inFlight.catch(() => {});
      // If the above finalizer scheduled another fireNow, drain that too.
      while (busy || pendingText !== null) {
        if (pendingText !== null && !busy) {
          const text = pendingText;
          pendingText = null;
          busy = true;
          try {
            await fn(text);
          } catch {
            // swallow
          }
          busy = false;
          lastFlushAt = now();
        } else if (busy) {
          await inFlight.catch(() => {});
        }
      }
    },
    cancel(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pendingText = null;
    },
  };
}
