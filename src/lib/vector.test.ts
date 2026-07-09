import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Sentry from "@sentry/nextjs";

const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn() }));
vi.mock("./logger", () => ({
  log: (...args: unknown[]) => logSpy(...args),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

// NOTE: no vi.mock of "@upstash/vector". The SDK is isolated behind the
// VectorStore interface; tests inject a fake store via the factory seam,
// so this suite pins OUR chokepoint contract, not the SDK surface.
import {
  vectorQuery,
  vectorUpsert,
  vectorDelete,
  vectorDeleteNamespace,
  isVectorConfigured,
  kbNamespace,
  docsNamespace,
  srcNamespace,
  VECTOR_OP_TIMEOUT_MS,
  __setVectorStoreFactoryForTests,
  type VectorStore,
} from "./vector";

function makeFakeStore(overrides: Partial<VectorStore> = {}): VectorStore {
  return {
    upsert: vi.fn(async () => {}),
    query: vi.fn(async () => [
      { id: "doc-1", score: 0.91, metadata: { path: "docs/setup.md" } },
      { id: "doc-2", score: 0.84, metadata: { path: "docs/usage.md" } },
    ]),
    delete: vi.fn(async () => {}),
    deleteNamespace: vi.fn(async () => {}),
    ...overrides,
  };
}

function stubVectorEnv(): void {
  vi.stubEnv("UPSTASH_VECTOR_REST_URL", "https://example-vector.upstash.io");
  vi.stubEnv("UPSTASH_VECTOR_REST_TOKEN", "test-token");
}

beforeEach(() => {
  logSpy.mockClear();
  vi.mocked(Sentry.captureException).mockClear();
  // Reset the memoized store between tests.
  __setVectorStoreFactoryForTests(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  __setVectorStoreFactoryForTests(null);
});

describe("namespace helpers (pure given env)", () => {
  it("kbNamespace is {owner}/{repo}:kb", () => {
    vi.stubEnv("GITHUB_OWNER", "acme");
    vi.stubEnv("GITHUB_REPO", "backend");
    expect(kbNamespace()).toBe("acme/backend:kb");
  });

  it("docsNamespace is {owner}/{repo}:docs:{sha}", () => {
    vi.stubEnv("GITHUB_OWNER", "acme");
    vi.stubEnv("GITHUB_REPO", "backend");
    expect(docsNamespace("abc1234")).toBe("acme/backend:docs:abc1234");
  });

  it("srcNamespace is the stable owner/repo:src namespace (no SHA suffix)", () => {
    vi.stubEnv("GITHUB_OWNER", "acme");
    vi.stubEnv("GITHUB_REPO", "backend");
    expect(srcNamespace()).toBe("acme/backend:src");
  });
});

describe("isVectorConfigured", () => {
  it("false when both env vars are absent", () => {
    vi.stubEnv("UPSTASH_VECTOR_REST_URL", "");
    vi.stubEnv("UPSTASH_VECTOR_REST_TOKEN", "");
    expect(isVectorConfigured()).toBe(false);
  });

  it("false when only the URL is set", () => {
    vi.stubEnv("UPSTASH_VECTOR_REST_URL", "https://example-vector.upstash.io");
    vi.stubEnv("UPSTASH_VECTOR_REST_TOKEN", "");
    expect(isVectorConfigured()).toBe(false);
  });

  it("true when both are set", () => {
    stubVectorEnv();
    expect(isVectorConfigured()).toBe(true);
  });
});

describe("degradation: not configured", () => {
  beforeEach(() => {
    vi.stubEnv("UPSTASH_VECTOR_REST_URL", "");
    vi.stubEnv("UPSTASH_VECTOR_REST_TOKEN", "");
  });

  it("vectorQuery returns null and logs vector_unavailable; the store factory is never invoked", async () => {
    const factory = vi.fn(() => makeFakeStore());
    __setVectorStoreFactoryForTests(factory);

    const result = await vectorQuery("acme/backend:kb", "how does auth work", 10);
    expect(result).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "vector_unavailable",
      expect.objectContaining({ op: "query", reason: "not_configured" }),
    );
  });

  it("vectorUpsert returns false and logs vector_unavailable", async () => {
    const factory = vi.fn(() => makeFakeStore());
    __setVectorStoreFactoryForTests(factory);

    const ok = await vectorUpsert("acme/backend:kb", [{ id: "e1", text: "fact" }]);
    expect(ok).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "vector_unavailable",
      expect.objectContaining({ op: "upsert", reason: "not_configured" }),
    );
  });

  it("unconfigured is NOT an error: no vector_error, no Sentry capture", async () => {
    await vectorQuery("ns", "q", 5);
    expect(logSpy.mock.calls.map((c) => c[0])).not.toContain("vector_error");
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("happy path observability", () => {
  beforeEach(() => stubVectorEnv());

  it("vectorQuery returns matches and logs vector_op with op/namespace/durationMs/count", async () => {
    __setVectorStoreFactoryForTests(() => makeFakeStore());
    const matches = await vectorQuery("acme/backend:docs:abc", "deployment flow", 10);
    expect(matches).toHaveLength(2);
    expect(matches![0]).toEqual(
      expect.objectContaining({ id: "doc-1", score: 0.91 }),
    );
    const call = logSpy.mock.calls.find((c) => c[0] === "vector_op");
    expect(call).toBeDefined();
    const payload = call![1] as Record<string, unknown>;
    expect(payload.op).toBe("query");
    expect(payload.namespace).toBe("acme/backend:docs:abc");
    expect(payload.count).toBe(2);
    expect(typeof payload.durationMs).toBe("number");
  });

  it("an available store with no matches returns [] (distinct from null)", async () => {
    __setVectorStoreFactoryForTests(() =>
      makeFakeStore({ query: vi.fn(async () => []) }),
    );
    const matches = await vectorQuery("ns", "q", 10);
    expect(matches).toEqual([]);
    expect(matches).not.toBeNull();
  });

  it("memoizes the store: two calls construct it once", async () => {
    const factory = vi.fn(() => makeFakeStore());
    __setVectorStoreFactoryForTests(factory);
    await vectorQuery("ns", "q1", 5);
    await vectorQuery("ns", "q2", 5);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("vectorUpsert forwards items, returns true, and logs count", async () => {
    const store = makeFakeStore();
    __setVectorStoreFactoryForTests(() => store);
    const items = [
      { id: "e1", text: "fact one", metadata: { timestamp: "2026-07-01" } },
      { id: "e2", text: "fact two", metadata: { timestamp: "2026-07-02" } },
    ];
    const ok = await vectorUpsert("acme/backend:kb", items);
    expect(ok).toBe(true);
    expect(store.upsert).toHaveBeenCalledWith("acme/backend:kb", items);
    expect(logSpy).toHaveBeenCalledWith(
      "vector_op",
      expect.objectContaining({ op: "upsert", count: 2 }),
    );
  });

  it("vectorUpsert with an empty item list short-circuits true without touching the store", async () => {
    const store = makeFakeStore();
    __setVectorStoreFactoryForTests(() => store);
    const ok = await vectorUpsert("acme/backend:kb", []);
    expect(ok).toBe(true);
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("vectorDelete and vectorDeleteNamespace return true and log their ops", async () => {
    const store = makeFakeStore();
    __setVectorStoreFactoryForTests(() => store);
    expect(await vectorDelete("acme/backend:kb", ["e1"])).toBe(true);
    expect(await vectorDeleteNamespace("acme/backend:docs:old")).toBe(true);
    expect(store.delete).toHaveBeenCalledWith("acme/backend:kb", ["e1"]);
    expect(store.deleteNamespace).toHaveBeenCalledWith("acme/backend:docs:old");
  });
});

describe("degradation: store errors never throw", () => {
  beforeEach(() => stubVectorEnv());

  it("query error → null + vector_error + Sentry tagged vector.op", async () => {
    const err = new Error("upstash vector unreachable");
    __setVectorStoreFactoryForTests(() =>
      makeFakeStore({ query: vi.fn(async () => { throw err; }) }),
    );
    const result = await vectorQuery("acme/backend:kb", "q", 10);
    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(
      "vector_error",
      expect.objectContaining({
        op: "query",
        errorClass: "Error",
        errorMessage: expect.stringContaining("unreachable"),
      }),
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({ "vector.op": "query" }),
      }),
    );
  });

  it("upsert error → false, no throw", async () => {
    __setVectorStoreFactoryForTests(() =>
      makeFakeStore({ upsert: vi.fn(async () => { throw new Error("boom"); }) }),
    );
    await expect(
      vectorUpsert("ns", [{ id: "e1", text: "t" }]),
    ).resolves.toBe(false);
    expect(logSpy).toHaveBeenCalledWith(
      "vector_error",
      expect.objectContaining({ op: "upsert" }),
    );
  });

  it("delete and deleteNamespace errors → false, no throw", async () => {
    __setVectorStoreFactoryForTests(() =>
      makeFakeStore({
        delete: vi.fn(async () => { throw new Error("boom"); }),
        deleteNamespace: vi.fn(async () => { throw new Error("boom"); }),
      }),
    );
    await expect(vectorDelete("ns", ["x"])).resolves.toBe(false);
    await expect(vectorDeleteNamespace("ns")).resolves.toBe(false);
  });
});

describe("degradation: timeout", () => {
  beforeEach(() => stubVectorEnv());

  it("query exceeding VECTOR_OP_TIMEOUT_MS resolves null and logs vector_error with VectorTimeoutError", async () => {
    vi.useFakeTimers();
    __setVectorStoreFactoryForTests(() =>
      makeFakeStore({ query: () => new Promise(() => {}) }), // never resolves
    );
    const pending = vectorQuery("acme/backend:kb", "slow question", 10);
    await vi.advanceTimersByTimeAsync(VECTOR_OP_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBeNull();
    expect(logSpy).toHaveBeenCalledWith(
      "vector_error",
      expect.objectContaining({ op: "query", errorClass: "VectorTimeoutError" }),
    );
  });
});

describe("privacy: content never reaches logs", () => {
  beforeEach(() => stubVectorEnv());

  it("neither query text nor upserted text appears in any log payload", async () => {
    __setVectorStoreFactoryForTests(() => makeFakeStore());
    await vectorQuery("acme/backend:kb", "SECRET_QUESTION_TEXT", 10);
    await vectorUpsert("acme/backend:kb", [
      { id: "e1", text: "SECRET_KB_ENTRY_BODY" },
    ]);
    for (const call of logSpy.mock.calls) {
      const payload = JSON.stringify(call);
      expect(payload).not.toContain("SECRET_QUESTION_TEXT");
      expect(payload).not.toContain("SECRET_KB_ENTRY_BODY");
    }
  });
});
