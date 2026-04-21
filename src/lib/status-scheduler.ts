/**
 * Status-update scheduler for long-running agent turns.
 *
 * Wraps `createThrottledUpdater` with two additional behaviors:
 *
 * 1. **Coalesced updates.** Rapid `schedule()` calls (e.g., a burst from
 *    parallel tool dispatch — see #77) collapse into at most one Slack
 *    `chat.update` per `debounceMs`, with the LATEST text winning. Prevents
 *    UI flicker and Slack's ~1/sec per-message rate limit from biting.
 *
 * 2. **Rotation heartbeat.** If no `schedule()` arrives for `rotationMs`,
 *    the scheduler fires `rotationText` as a "still working…" heartbeat.
 *    Stops Slack from auto-dimming the thinking message during long
 *    Anthropic calls (e.g., a 40-second model response).
 *
 * Errors from `fn` are swallowed — a failing `chat.update` (rate-limited,
 * message deleted, network blip) must never crash the agent loop.
 *
 * See #78.
 */

import { createThrottledUpdater } from "./slack-throttle";

export interface StatusSchedulerConfig {
  /** Minimum ms between successive fn() calls. Coalesces bursts. */
  debounceMs: number;
  /**
   * Rotation interval — if no schedule() call for this long, fn is
   * called with `rotationText`. Set to 0 to disable rotation.
   */
  rotationMs: number;
  /** Text to use for the periodic rotation heartbeat. */
  rotationText: string;
}

export interface StatusScheduler {
  /** Queue an update. Coalesced with any pending update in the debounce window. */
  schedule(text: string): void;
  /** Force any pending update through AND stop rotation. Call on turn end. */
  flush(): Promise<void>;
  /** Drop any pending update AND stop rotation. Call when replacing this updater. */
  cancel(): Promise<void>;
}

export function createStatusScheduler(
  fn: (text: string) => Promise<void>,
  config: StatusSchedulerConfig,
): StatusScheduler {
  const throttle = createThrottledUpdater(fn, config.debounceMs);
  let rotationTimer: ReturnType<typeof setTimeout> | null = null;

  function stopRotation(): void {
    if (rotationTimer) {
      clearTimeout(rotationTimer);
      rotationTimer = null;
    }
  }

  // Re-arms a one-shot timer that fires rotationText after rotationMs.
  // Any schedule() call calls armRotation again, restarting the window.
  // When the timer fires it also re-arms itself so idle periods get
  // multiple rotation ticks, not just one.
  function armRotation(): void {
    stopRotation();
    if (config.rotationMs <= 0) return;
    rotationTimer = setTimeout(() => {
      throttle.update(config.rotationText);
      armRotation();
    }, config.rotationMs);
  }

  return {
    schedule(text: string): void {
      throttle.update(text);
      armRotation();
    },
    async flush(): Promise<void> {
      stopRotation();
      await throttle.flush();
    },
    async cancel(): Promise<void> {
      stopRotation();
      await throttle.cancel();
    },
  };
}

// Sensible defaults derived from Slack's rate-limit reality + UX research
// on how long a status needs to be visible to be read.
export const DEFAULT_STATUS_DEBOUNCE_MS = 1200;
export const DEFAULT_STATUS_ROTATION_MS = 30_000;
export const DEFAULT_STATUS_ROTATION_TEXT = "🧠 Still working on it...";
