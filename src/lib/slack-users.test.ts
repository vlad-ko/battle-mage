import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ThreadMessage } from "./thread-filter";

// Mock the KV client first so our slack-users module picks up the mock.
// Defaults to Promise-returning so fire-and-forget `kv.set(...).catch()`
// calls in the module don't trip on undefined. Individual tests can
// override behavior via .mockImplementation.
const kvGet = vi.fn().mockResolvedValue(null);
const kvSet = vi.fn().mockResolvedValue("OK");
vi.mock("./kv", () => ({
  kv: {
    get: (...args: unknown[]) => kvGet(...args),
    set: (...args: unknown[]) => kvSet(...args),
  },
}));

// Mock the slack client's users.info — we control its behavior per test.
const usersInfo = vi.fn();
vi.mock("./slack", () => ({
  slack: {
    users: {
      info: (...args: unknown[]) => usersInfo(...args),
    },
  },
}));

// Import AFTER mocks are registered so the module resolves against them.
import {
  extractParticipantIds,
  resolveParticipants,
  PARTICIPANT_CACHE_TTL_SECONDS,
} from "./slack-users";

const BOT_ID = "U_BOT";

describe("extractParticipantIds", () => {
  it("returns unique user IDs from message authors", () => {
    const msgs: ThreadMessage[] = [
      { user: "U1", text: "hi" },
      { user: "U2", text: "hello" },
      { user: "U1", text: "again" }, // duplicate author
    ];
    expect(extractParticipantIds(msgs, BOT_ID).sort()).toEqual(["U1", "U2"]);
  });

  it("excludes the bot's own user ID", () => {
    const msgs: ThreadMessage[] = [
      { user: "U1", text: "@bm help" },
      { user: BOT_ID, text: "bot reply", bot_id: "B001" },
    ];
    expect(extractParticipantIds(msgs, BOT_ID)).toEqual(["U1"]);
  });

  it("also extracts user IDs from <@U...> mention tokens in text", () => {
    // A thread where the user asks about someone who hasn't posted yet —
    // we still want that ID resolvable so the bot can @-mention them.
    const msgs: ThreadMessage[] = [
      { user: "U1", text: "can you ping <@U99> about this?" },
    ];
    expect(extractParticipantIds(msgs, BOT_ID).sort()).toEqual(["U1", "U99"]);
  });

  it("excludes the bot's ID even when it appears in text as a mention", () => {
    const msgs: ThreadMessage[] = [
      { user: "U1", text: `<@${BOT_ID}> what does this do?` },
    ];
    expect(extractParticipantIds(msgs, BOT_ID)).toEqual(["U1"]);
  });

  it("returns empty array for empty thread", () => {
    expect(extractParticipantIds([], BOT_ID)).toEqual([]);
  });

  it("returns empty array when bot is sole author", () => {
    const msgs: ThreadMessage[] = [
      { user: BOT_ID, text: "bot solo", bot_id: "B001" },
    ];
    expect(extractParticipantIds(msgs, BOT_ID)).toEqual([]);
  });

  it("works when botUserId is undefined (no-op filter)", () => {
    // If we can't determine the bot's ID, don't filter anything.
    const msgs: ThreadMessage[] = [{ user: "U1", text: "<@U2>" }];
    expect(extractParticipantIds(msgs, undefined).sort()).toEqual(["U1", "U2"]);
  });

  it("skips messages with no user field", () => {
    const msgs: ThreadMessage[] = [
      { text: "system message" },
      { user: "U1", text: "real user" },
    ];
    expect(extractParticipantIds(msgs, BOT_ID)).toEqual(["U1"]);
  });
});

describe("resolveParticipants", () => {
  beforeEach(() => {
    // Clear call history but re-establish Promise-returning defaults so
    // `kv.set(...).catch()` in production code doesn't trip on undefined.
    kvGet.mockReset().mockResolvedValue(null);
    kvSet.mockReset().mockResolvedValue("OK");
    usersInfo.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns cached display names without calling slack.users.info", async () => {
    kvGet.mockImplementation(async (key: string) => {
      if (key === "slack_user:U1") return "Vlad";
      if (key === "slack_user:U2") return "Cole";
      return null;
    });

    const result = await resolveParticipants(["U1", "U2"]);

    expect(result).toEqual([
      { id: "U1", displayName: "Vlad" },
      { id: "U2", displayName: "Cole" },
    ]);
    expect(usersInfo).not.toHaveBeenCalled();
  });

  it("falls through to slack.users.info on cache miss and stores result", async () => {
    kvGet.mockResolvedValue(null);
    usersInfo.mockResolvedValue({
      ok: true,
      user: { id: "U1", name: "vlad", real_name: "Vlad Kostanjsek", profile: {} },
    });

    const result = await resolveParticipants(["U1"]);

    expect(result).toEqual([{ id: "U1", displayName: "Vlad Kostanjsek" }]);
    expect(usersInfo).toHaveBeenCalledWith({ user: "U1" });
    expect(kvSet).toHaveBeenCalledWith(
      "slack_user:U1",
      "Vlad Kostanjsek",
      { ex: PARTICIPANT_CACHE_TTL_SECONDS },
    );
  });

  it("prefers display_name over real_name when available", async () => {
    kvGet.mockResolvedValue(null);
    usersInfo.mockResolvedValue({
      ok: true,
      user: {
        id: "U1",
        real_name: "Vlad Kostanjsek",
        profile: { display_name: "vjk" },
      },
    });

    const result = await resolveParticipants(["U1"]);
    expect(result[0].displayName).toBe("vjk");
  });

  it("falls back to the user ID when users.info returns an error", async () => {
    kvGet.mockResolvedValue(null);
    usersInfo.mockResolvedValue({ ok: false, error: "user_not_found" });

    const result = await resolveParticipants(["U_DELETED"]);

    expect(result).toEqual([{ id: "U_DELETED", displayName: "U_DELETED" }]);
    // Still cache the fallback so we don't retry every turn.
    expect(kvSet).toHaveBeenCalledWith(
      "slack_user:U_DELETED",
      "U_DELETED",
      { ex: PARTICIPANT_CACHE_TTL_SECONDS },
    );
  });

  it("falls back to the user ID when users.info throws", async () => {
    kvGet.mockResolvedValue(null);
    usersInfo.mockRejectedValue(new Error("rate_limited"));

    const result = await resolveParticipants(["U1"]);
    expect(result).toEqual([{ id: "U1", displayName: "U1" }]);
  });

  it("handles a mix of cached and uncached users", async () => {
    kvGet.mockImplementation(async (key: string) => {
      if (key === "slack_user:U1") return "Vlad";
      return null; // U2 uncached
    });
    usersInfo.mockResolvedValue({
      ok: true,
      user: { id: "U2", real_name: "Cole", profile: {} },
    });

    const result = await resolveParticipants(["U1", "U2"]);

    expect(result).toEqual([
      { id: "U1", displayName: "Vlad" },
      { id: "U2", displayName: "Cole" },
    ]);
    // users.info called only for the uncached one.
    expect(usersInfo).toHaveBeenCalledOnce();
    expect(usersInfo).toHaveBeenCalledWith({ user: "U2" });
  });

  it("returns empty array for empty input (no api calls)", async () => {
    const result = await resolveParticipants([]);
    expect(result).toEqual([]);
    expect(kvGet).not.toHaveBeenCalled();
    expect(usersInfo).not.toHaveBeenCalled();
  });

  it("preserves the caller's input order", async () => {
    kvGet.mockResolvedValue(null);
    usersInfo.mockImplementation(async ({ user }: { user: string }) => ({
      ok: true,
      user: { id: user, real_name: user.toLowerCase(), profile: {} },
    }));

    const result = await resolveParticipants(["U3", "U1", "U2"]);
    expect(result.map((p) => p.id)).toEqual(["U3", "U1", "U2"]);
  });
});

describe("constants", () => {
  it("PARTICIPANT_CACHE_TTL_SECONDS is 1 hour per #80", () => {
    expect(PARTICIPANT_CACHE_TTL_SECONDS).toBe(3600);
  });
});
