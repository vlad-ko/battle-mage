import { describe, it, expect } from "vitest";
import { createFakeSlack } from "./fake-slack";

describe("createFakeSlack", () => {
  const seed = {
    botUserId: "U0BM",
    channel: "C0DEV",
    thread: [{ user: "U0VJK", text: "<@U0BM> hello", ts: "1751371200.000100" }],
    users: { U0VJK: "vlad" },
  };

  it("auth.test returns the seeded bot user id", async () => {
    const f = createFakeSlack(seed);
    expect((await f.client.auth.test()).user_id).toBe("U0BM");
  });

  it("postMessage returns strictly increasing ts strings and appends to thread state", async () => {
    const f = createFakeSlack(seed);
    const a = await f.client.chat.postMessage({ channel: "C0DEV", thread_ts: "1751371200.000100", text: "one" });
    const b = await f.client.chat.postMessage({ channel: "C0DEV", thread_ts: "1751371200.000100", text: "two" });
    expect(Number(b.ts)).toBeGreaterThan(Number(a.ts));
    const replies = await f.client.conversations.replies({ channel: "C0DEV", ts: "1751371200.000100" });
    expect(replies.messages!.map((m) => m.text)).toEqual(["<@U0BM> hello", "one", "two"]);
    expect(replies.messages![1].user).toBe("U0BM");
  });

  it("chat.update mutates the stored message text in place", async () => {
    const f = createFakeSlack(seed);
    const { ts } = await f.client.chat.postMessage({ channel: "C0DEV", thread_ts: "1751371200.000100", text: "thinking…" });
    await f.client.chat.update({ channel: "C0DEV", ts: ts!, text: "final answer" });
    const replies = await f.client.conversations.replies({ channel: "C0DEV", ts: "1751371200.000100" });
    expect(replies.messages!.at(-1)!.text).toBe("final answer");
  });

  it("records every call in order with method names, distinguishing writes from reads", async () => {
    const f = createFakeSlack(seed);
    await f.client.conversations.replies({ channel: "C0DEV", ts: "1751371200.000100" });
    await f.client.chat.postMessage({ channel: "C0DEV", thread_ts: "1751371200.000100", text: "x" });
    expect(f.calls.map((c) => c.method)).toEqual(["conversations.replies", "chat.postMessage"]);
  });

  it("users.info resolves seeded display names", async () => {
    const f = createFakeSlack(seed);
    const info = await f.client.users.info({ user: "U0VJK" });
    expect(info.user?.profile?.display_name ?? info.user?.real_name).toBe("vlad");
  });

  // Qodo finding #2 on PR #140: production fetchMessage() calls
  // conversations.replies with {ts, inclusive: true, limit: 1} and relies
  // on messages[0] being the TARGET message — Slack semantics the fake
  // must honor. Generic limit is "first N of the thread, oldest first".
  describe("conversations.replies inclusive/limit semantics", () => {
    it("inclusive:true + limit:1 returns exactly the mid-thread target message", async () => {
      const f = createFakeSlack(seed);
      const a = await f.client.chat.postMessage({ channel: "C0DEV", thread_ts: "1751371200.000100", text: "one" });
      await f.client.chat.postMessage({ channel: "C0DEV", thread_ts: "1751371200.000100", text: "two" });
      const r = await f.client.conversations.replies({
        channel: "C0DEV",
        ts: a.ts!,
        inclusive: true,
        limit: 1,
      });
      expect(r.messages).toHaveLength(1);
      expect(r.messages![0].ts).toBe(a.ts);
      expect(r.messages![0].text).toBe("one");
    });

    it("inclusive:true + limit:1 with an unknown ts returns an empty list", async () => {
      const f = createFakeSlack(seed);
      const r = await f.client.conversations.replies({
        channel: "C0DEV",
        ts: "9999999999.000001",
        inclusive: true,
        limit: 1,
      });
      expect(r.messages).toEqual([]);
    });

    it("a generic limit returns the first N thread messages, oldest first", async () => {
      const f = createFakeSlack(seed);
      await f.client.chat.postMessage({ channel: "C0DEV", thread_ts: "1751371200.000100", text: "one" });
      await f.client.chat.postMessage({ channel: "C0DEV", thread_ts: "1751371200.000100", text: "two" });
      const r = await f.client.conversations.replies({
        channel: "C0DEV",
        ts: "1751371200.000100",
        limit: 2,
      });
      expect(r.messages!.map((m) => m.text)).toEqual(["<@U0BM> hello", "one"]);
    });
  });
});
