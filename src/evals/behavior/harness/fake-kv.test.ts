import { describe, it, expect } from "vitest";
import { createFakeKV } from "./fake-kv";

describe("createFakeKV", () => {
  it("del returns 0 on a missing key and 1 on a present key (double-approve claim race)", async () => {
    const f = createFakeKV();
    expect(await f.kv.del("nope")).toBe(0);
    await f.kv.set("pending-issue-batch:C0DEV:1.0001", { proposals: [] });
    expect(await f.kv.del("pending-issue-batch:C0DEV:1.0001")).toBe(1);
    expect(await f.kv.del("pending-issue-batch:C0DEV:1.0001")).toBe(0);
  });

  it("set NX returns null when the key exists (idempotency lock semantics)", async () => {
    const f = createFakeKV();
    expect(await f.kv.set("idem:issue:x", { status: "pending" }, { nx: true, ex: 60 })).toBe("OK");
    expect(await f.kv.set("idem:issue:x", { status: "pending" }, { nx: true, ex: 60 })).toBeNull();
  });

  it("JSON round-trips objects on get (upstash auto-parse)", async () => {
    const f = createFakeKV();
    await f.kv.set("k", { a: 1, b: "two" });
    expect(await f.kv.get("k")).toEqual({ a: 1, b: "two" });
    expect(await f.kv.get("missing")).toBeNull();
  });

  it("keysWithPrefix matches only exact prefixes (thread pointer excluded)", async () => {
    const f = createFakeKV();
    await f.kv.set("pending-issue-batch:C0DEV:1751371300.000002", {});
    await f.kv.set("pending-issue-batch:thread:C0DEV:1751371200.000100", "1751371300.000002");
    expect(f.keysWithPrefix("pending-issue-batch:C0DEV:")).toEqual([
      "pending-issue-batch:C0DEV:1751371300.000002",
    ]);
  });

  it("zrange sorts ascending, honors rev and -1 stop, and auto-parses JSON members", async () => {
    const f = createFakeKV();
    await f.kv.zadd("z", { score: 2, member: JSON.stringify({ id: "b" }) });
    await f.kv.zadd("z", { score: 1, member: JSON.stringify({ id: "a" }) });
    await f.kv.zadd("z", { score: 3, member: "raw-string" });
    expect(await f.kv.zrange("z", 0, -1)).toEqual([{ id: "a" }, { id: "b" }, "raw-string"]);
    expect(await f.kv.zrange("z", 0, 0, { rev: true })).toEqual(["raw-string"]);
  });
});
