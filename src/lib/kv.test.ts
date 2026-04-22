import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/nextjs";

// Mock logger BEFORE importing kv so the logged events are observable.
const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn() }));
vi.mock("./logger", () => ({
  log: (...args: unknown[]) => logSpy(...args),
}));

// Mock Sentry.
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

// Mock @upstash/redis. `vi.hoisted` ensures the mock object exists
// before `vi.mock`'s factory runs (vitest hoists vi.mock above imports
// and top-level consts).
const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  zadd: vi.fn(),
  zrange: vi.fn(),
  zrem: vi.fn(),
}));
vi.mock("@upstash/redis", () => ({
  Redis: {
    fromEnv: () => redisMock,
  },
}));

// Import AFTER mocks are registered.
import { kv, keyPrefix } from "./kv";

describe("keyPrefix (pure)", () => {
  it("returns everything before the first colon — drops all segments after", () => {
    expect(keyPrefix("feedback:context:C01ABC:1234.5678")).toBe("feedback");
    expect(keyPrefix("pending-correction:C01:T1")).toBe("pending-correction");
    expect(keyPrefix("knowledge:entries")).toBe("knowledge");
    expect(keyPrefix("repo-index:sha")).toBe("repo-index");
  });

  it("returns the key itself if no colons", () => {
    expect(keyPrefix("bare_key")).toBe("bare_key");
  });

  it("never leaks channel or timestamp ID segments", () => {
    // Channel IDs (C01ABCDEF) and timestamps (1234.5678) must never
    // appear in the bucketed prefix used for log aggregation.
    const prefix = keyPrefix("feedback:context:C01ABCDEF:1234.5678");
    expect(prefix).not.toContain("C01");
    expect(prefix).not.toContain("1234");
  });
});

describe("kv.get observability", () => {
  beforeEach(() => {
    logSpy.mockClear();
    vi.mocked(Sentry.captureException).mockClear();
    redisMock.get.mockReset();
  });

  it("logs kv_op with op=get and hit=true when value is present", async () => {
    redisMock.get.mockResolvedValue("someValue");
    const result = await kv.get<string>("feedback:entries");
    expect(result).toBe("someValue");
    expect(logSpy).toHaveBeenCalledWith(
      "kv_op",
      expect.objectContaining({
        op: "get",
        keyPrefix: "feedback",
        hit: true,
      }),
    );
  });

  it("logs kv_op with hit=false when value is null", async () => {
    redisMock.get.mockResolvedValue(null);
    const result = await kv.get<string>("feedback:context:abc:123");
    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(
      "kv_op",
      expect.objectContaining({ op: "get", hit: false, keyPrefix: "feedback" }),
    );
  });

  it("logs durationMs on success", async () => {
    redisMock.get.mockResolvedValue("x");
    await kv.get<string>("k");
    const payload = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(typeof payload.durationMs).toBe("number");
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("logs kv_error + captures Sentry exception + rethrows on failure", async () => {
    const err = new Error("upstash unreachable");
    redisMock.get.mockRejectedValue(err);
    await expect(kv.get("feedback:context:c:t")).rejects.toThrow("upstash unreachable");
    expect(logSpy).toHaveBeenCalledWith(
      "kv_error",
      expect.objectContaining({
        op: "get",
        keyPrefix: "feedback",
        errorMessage: expect.stringContaining("upstash unreachable"),
      }),
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({ "kv.op": "get" }),
      }),
    );
  });

  it("NEVER logs the full key or the value", async () => {
    redisMock.get.mockResolvedValue("secret-value");
    await kv.get("feedback:context:C01:1234.5678");
    for (const call of logSpy.mock.calls) {
      const payload = JSON.stringify(call);
      expect(payload).not.toContain("C01:1234.5678");
      expect(payload).not.toContain("secret-value");
    }
  });
});

describe("kv.set observability", () => {
  beforeEach(() => {
    logSpy.mockClear();
    vi.mocked(Sentry.captureException).mockClear();
    redisMock.set.mockReset();
  });

  it("passes TTL options through and logs op=set with valueSize", async () => {
    redisMock.set.mockResolvedValue("OK");
    await kv.set("knowledge:entries", "payload-of-size-17", { ex: 86400 });
    expect(redisMock.set).toHaveBeenCalledWith("knowledge:entries", "payload-of-size-17", { ex: 86400 });
    expect(logSpy).toHaveBeenCalledWith(
      "kv_op",
      expect.objectContaining({
        op: "set",
        keyPrefix: "knowledge",
        valueSize: "payload-of-size-17".length,
      }),
    );
  });

  it("handles non-string values (auto-stringified by upstash) with sensible valueSize", async () => {
    redisMock.set.mockResolvedValue("OK");
    const obj = { foo: "bar", n: 42 };
    await kv.set("some:key", obj);
    const call = logSpy.mock.calls.find((c) => c[0] === "kv_op");
    expect(call).toBeDefined();
    const payload = call?.[1] as Record<string, unknown>;
    expect(payload.op).toBe("set");
    expect(typeof payload.valueSize).toBe("number");
    expect(payload.valueSize).toBeGreaterThan(0);
  });

  it("captures Sentry exception and rethrows on failure", async () => {
    const err = new Error("write failed");
    redisMock.set.mockRejectedValue(err);
    await expect(kv.set("k", "v")).rejects.toThrow("write failed");
    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: expect.objectContaining({ "kv.op": "set" }) }),
    );
  });
});

describe("kv.del observability", () => {
  beforeEach(() => {
    logSpy.mockClear();
    vi.mocked(Sentry.captureException).mockClear();
    redisMock.del.mockReset();
  });

  it("logs op=del and forwards the result count", async () => {
    redisMock.del.mockResolvedValue(1);
    const result = await kv.del("pending-correction:C:T");
    expect(result).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(
      "kv_op",
      expect.objectContaining({ op: "del", keyPrefix: "pending-correction" }),
    );
  });
});

describe("kv.zadd observability", () => {
  beforeEach(() => {
    logSpy.mockClear();
    redisMock.zadd.mockReset();
  });

  it("logs op=zadd with the key prefix", async () => {
    redisMock.zadd.mockResolvedValue(1);
    await kv.zadd("feedback:entries", { score: Date.now(), member: "payload" });
    expect(logSpy).toHaveBeenCalledWith(
      "kv_op",
      expect.objectContaining({ op: "zadd", keyPrefix: "feedback" }),
    );
  });
});

describe("kv.zrem observability", () => {
  beforeEach(() => {
    logSpy.mockClear();
    redisMock.zrem.mockReset();
  });

  it("logs op=zrem with key prefix and removed count", async () => {
    redisMock.zrem.mockResolvedValue(1);
    const result = await kv.zrem("knowledge:entries", "some member");
    expect(result).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(
      "kv_op",
      expect.objectContaining({
        op: "zrem",
        keyPrefix: "knowledge",
        removed: 1,
      }),
    );
  });
});

describe("kv.zrange observability", () => {
  beforeEach(() => {
    logSpy.mockClear();
    redisMock.zrange.mockReset();
  });

  it("logs op=zrange with rangeSize (number of results)", async () => {
    redisMock.zrange.mockResolvedValue(["a", "b", "c"]);
    await kv.zrange("feedback:entries", 0, -1, { rev: true });
    expect(logSpy).toHaveBeenCalledWith(
      "kv_op",
      expect.objectContaining({
        op: "zrange",
        keyPrefix: "feedback",
        rangeSize: 3,
      }),
    );
  });

  it("handles an empty range result", async () => {
    redisMock.zrange.mockResolvedValue([]);
    const result = await kv.zrange("feedback:entries", 0, -1);
    expect(result).toEqual([]);
    const call = logSpy.mock.calls.find((c) => c[0] === "kv_op");
    expect((call?.[1] as Record<string, unknown>).rangeSize).toBe(0);
  });
});

