// ── In-memory Slack fake for behavior evals (#137) ───────────────────
// Slack is ALWAYS faked (invariant I6) — never recorded, never live.
// The fake stands in for the @slack/web-api WebClient so src/lib/slack.ts
// runs REAL against it: message threading, in-place updates, deletes and
// user lookups behave like a tiny Slack, and every API call is logged in
// order so contracts can distinguish writes from reads.

export interface FakeSlackSeedMessage {
  user: string;
  text: string;
  ts: string;
}

export interface FakeSlackSeed {
  botUserId: string;
  channel: string;
  /** Initial thread state, oldest first. The first message is the root. */
  thread: FakeSlackSeedMessage[];
  /** userId → display name for users.info. */
  users?: Record<string, string>;
}

export interface FakeSlackCall {
  method: string;
  args: Record<string, unknown>;
}

export interface FakeStoredMessage {
  user?: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

export interface FakeSlack {
  /** Structural stand-in for @slack/web-api WebClient. */
  client: FakeSlackClient;
  /** Every API call, in order. */
  calls: FakeSlackCall[];
  /** Root ts of the seeded thread. */
  rootTs: string;
  /** Current messages of the seeded thread, oldest first. */
  threadMessages(): FakeStoredMessage[];
  /** Simulate a HUMAN posting into the seeded thread (not a bot API
   * call — records nothing). Returns the assigned ts. */
  appendUserMessage(user: string, text: string): string;
}

export interface FakeSlackClient {
  auth: { test(): Promise<{ ok: true; user_id: string }> };
  chat: {
    postMessage(args: {
      channel: string;
      thread_ts?: string;
      text: string;
    }): Promise<{ ok: true; ts?: string; channel: string }>;
    update(args: {
      channel: string;
      ts: string;
      text: string;
    }): Promise<{ ok: boolean; ts: string }>;
    delete(args: { channel: string; ts: string }): Promise<{ ok: boolean }>;
  };
  conversations: {
    replies(args: {
      channel: string;
      ts: string;
      limit?: number;
      inclusive?: boolean;
    }): Promise<{ ok: true; messages?: FakeStoredMessage[] }>;
  };
  users: {
    info(args: { user: string }): Promise<{
      ok: boolean;
      user?: {
        id: string;
        real_name?: string;
        profile?: { display_name?: string };
      };
    }>;
  };
}

export function createFakeSlack(seed: FakeSlackSeed): FakeSlack {
  const calls: FakeSlackCall[] = [];
  const rootTs = seed.thread[0]?.ts ?? "1751371200.000100";

  // All messages live in one flat, ordered store; threads are derived by
  // thread_ts (the root message's thread_ts is its own ts, like Slack).
  const messages: FakeStoredMessage[] = seed.thread.map((m, i) => ({
    user: m.user,
    text: m.text,
    ts: m.ts,
    thread_ts: i === 0 ? undefined : rootTs,
  }));

  // Strictly increasing ts generator: start 100 seconds after the newest
  // seeded message so seeds and generated ts never collide.
  const tsSeconds =
    Math.max(...seed.thread.map((m) => Math.floor(Number(m.ts))), 0) + 100;
  let tsCounter = 0;
  const nextTs = (): string => {
    tsCounter += 1;
    return `${tsSeconds}.${String(tsCounter).padStart(6, "0")}`;
  };

  const record = (method: string, args: Record<string, unknown>): void => {
    calls.push({ method, args });
  };

  const threadOf = (ts: string): FakeStoredMessage[] => {
    // Any ts in a thread resolves the whole thread (Slack semantics for
    // conversations.replies: root first, then replies in order).
    const target = messages.find((m) => m.ts === ts);
    const root = target?.thread_ts ?? ts;
    return messages.filter((m) => m.ts === root || m.thread_ts === root);
  };

  const client: FakeSlackClient = {
    auth: {
      async test() {
        record("auth.test", {});
        return { ok: true, user_id: seed.botUserId };
      },
    },
    chat: {
      async postMessage(args) {
        record("chat.postMessage", { ...args });
        const ts = nextTs();
        messages.push({
          user: seed.botUserId,
          text: args.text,
          ts,
          thread_ts: args.thread_ts || undefined,
        });
        return { ok: true, ts, channel: args.channel };
      },
      async update(args) {
        record("chat.update", { ...args });
        const msg = messages.find((m) => m.ts === args.ts);
        if (msg) msg.text = args.text;
        return { ok: Boolean(msg), ts: args.ts };
      },
      async delete(args) {
        record("chat.delete", { ...args });
        const idx = messages.findIndex((m) => m.ts === args.ts);
        if (idx !== -1) messages.splice(idx, 1);
        return { ok: idx !== -1 };
      },
    },
    conversations: {
      async replies(args) {
        record("conversations.replies", { ...args });
        // fetchMessage() contract (src/lib/slack.ts): {ts, inclusive:
        // true, limit: 1} returns the TARGET message itself as
        // messages[0] — or nothing when the ts doesn't exist.
        if (args.inclusive === true && args.limit === 1) {
          const target = messages.find((m) => m.ts === args.ts);
          return { ok: true, messages: target ? [{ ...target }] : [] };
        }
        // Generic case: whole thread oldest-first, capped at limit
        // (Slack returns the oldest messages first for replies).
        let thread = threadOf(args.ts).map((m) => ({ ...m }));
        if (typeof args.limit === "number") {
          thread = thread.slice(0, args.limit);
        }
        return { ok: true, messages: thread };
      },
    },
    users: {
      async info(args) {
        record("users.info", { ...args });
        const name = seed.users?.[args.user];
        if (!name) {
          throw new Error(`fake-slack users.info: unseeded user ${args.user}`);
        }
        return {
          ok: true,
          user: {
            id: args.user,
            real_name: name,
            profile: { display_name: name },
          },
        };
      },
    },
  };

  return {
    client,
    calls,
    rootTs,
    threadMessages: () => threadOf(rootTs).map((m) => ({ ...m })),
    appendUserMessage(user: string, text: string): string {
      const ts = nextTs();
      messages.push({ user, text, ts, thread_ts: rootTs });
      return ts;
    },
  };
}
