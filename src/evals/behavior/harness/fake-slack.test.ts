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
});
