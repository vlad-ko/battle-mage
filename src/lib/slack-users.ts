/**
 * Slack user ID → display name resolution with KV caching.
 *
 * Junior's pattern (see #80): pre-resolve every Slack user in a thread and
 * inject their IDs into the system prompt as `<@USERID>` tokens so the
 * model can @-mention teammates correctly without a separate tool call.
 *
 * `users.info` is rate-limited (Tier 4: ~50/min) and the display name for
 * a given user rarely changes. Cache results in Vercel KV with a 1-hour
 * TTL — cheap enough to keep, fresh enough that renames propagate within
 * an hour, forgiving enough that a cold thread doesn't burst the rate
 * limit on the first turn.
 *
 * Fail-safe: if `users.info` errors (user deactivated, token scope issue,
 * rate limit), fall back to the raw user ID as the display name. The
 * agent still gets a usable `<@USERID>` mention token; only the human
 * label is less friendly.
 */

import { kv } from "./kv";
import { slack } from "./slack";
import type { ThreadMessage } from "./thread-filter";

export interface Participant {
  id: string;
  displayName: string;
}

export const PARTICIPANT_CACHE_TTL_SECONDS = 3600;

const MENTION_RE = /<@([A-Z0-9]+)>/g;
const KV_PREFIX = "slack_user:";

/**
 * Extract unique user IDs from a thread, pulling from BOTH:
 *   - each message's `user` field (authors)
 *   - any `<@U...>` mention tokens in message text (referenced users)
 *
 * The bot's own ID is excluded so we don't render "@bm" in the prompt.
 * Returns in first-seen order so downstream rendering is deterministic.
 */
export function extractParticipantIds(
  messages: ThreadMessage[],
  botUserId: string | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (id: string) => {
    if (!id) return;
    if (botUserId && id === botUserId) return;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const m of messages) {
    if (m.user) add(m.user);
    const text = m.text ?? "";
    for (const match of text.matchAll(MENTION_RE)) {
      add(match[1]);
    }
  }
  return out;
}

/**
 * Resolve a list of user IDs to `{ id, displayName }` records. Preserves
 * the input order. Hits KV first; falls through to `slack.users.info` for
 * uncached IDs, caches the result for `PARTICIPANT_CACHE_TTL_SECONDS`.
 *
 * Display name preference:
 *   1. `profile.display_name` (user-chosen nickname)
 *   2. `real_name`
 *   3. the raw user ID (fallback when users.info errors or both above are empty)
 *
 * Never throws. A failed `users.info` call caches the fallback so we don't
 * retry every turn (rate-limit friendly; names resync when TTL expires).
 */
export async function resolveParticipants(
  userIds: string[],
): Promise<Participant[]> {
  if (userIds.length === 0) return [];

  const results = await Promise.all(
    userIds.map(async (id) => {
      const cached = await kv.get<string>(`${KV_PREFIX}${id}`);
      if (cached) return { id, displayName: cached };

      let displayName = id; // default fallback
      try {
        const resp = await slack.users.info({ user: id });
        if (resp.ok && resp.user) {
          const user = resp.user as {
            profile?: { display_name?: string };
            real_name?: string;
          };
          const chosen =
            user.profile?.display_name?.trim() ||
            user.real_name?.trim() ||
            "";
          if (chosen) displayName = chosen;
        }
      } catch {
        // Swallow — we'll cache the ID-as-display fallback to avoid
        // retrying on every turn.
      }

      // Fire-and-forget cache write; don't let KV slowness block us.
      kv.set(`${KV_PREFIX}${id}`, displayName, {
        ex: PARTICIPANT_CACHE_TTL_SECONDS,
      }).catch(() => {
        // KV transient failure must not abort the agent turn.
      });

      return { id, displayName };
    }),
  );

  return results;
}
