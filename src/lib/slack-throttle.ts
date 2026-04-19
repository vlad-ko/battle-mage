export interface ThrottledUpdater {
  update(text: string): void;
  flush(): Promise<void>;
}

// Coalesces rapid update() calls into at most one flush per minIntervalMs.
// The first call fires immediately; further calls within the interval are
// queued and collapsed to the LATEST text. flush() forces a pending write
// immediately and is safe to call repeatedly or when nothing is pending.
export function createThrottledUpdater(
  fn: (text: string) => Promise<void>,
  minIntervalMs: number,
  now: () => number = Date.now,
): ThrottledUpdater {
  let lastFlushAt = -Infinity;
  let pendingText: string | null = null;
  let pendingPromise: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const doFlush = async (text: string): Promise<void> => {
    lastFlushAt = now();
    pendingText = null;
    try {
      await fn(text);
    } catch {
      // Swallow — transient Slack errors (rate limit, message deleted) must not
      // break the agent loop. The next update will retry.
    }
  };

  return {
    update(text: string): void {
      pendingText = text;
      const elapsed = now() - lastFlushAt;
      if (elapsed >= minIntervalMs && !timer) {
        pendingPromise = doFlush(text);
        return;
      }
      if (!timer) {
        const delay = Math.max(0, minIntervalMs - elapsed);
        timer = setTimeout(() => {
          timer = null;
          const t = pendingText;
          if (t !== null) {
            pendingPromise = doFlush(t);
          }
        }, delay);
      }
    },
    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pendingPromise) {
        await pendingPromise.catch(() => {});
      }
      if (pendingText !== null) {
        await doFlush(pendingText);
      }
    },
  };
}
