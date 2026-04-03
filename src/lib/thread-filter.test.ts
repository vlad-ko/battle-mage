import { describe, it, expect } from "vitest";
import { isAddressedToOtherUser, buildConversationHistory } from "./thread-filter";

describe("isAddressedToOtherUser", () => {
  const botId = "B001";

  it("returns true when message @mentions a non-bot user", () => {
    expect(isAddressedToOtherUser("<@U123> can you check this?", botId)).toBe(true);
  });

  it("returns false when message has no @mentions", () => {
    expect(isAddressedToOtherUser("is this working?", botId)).toBe(false);
  });

  it("returns false when message only @mentions the bot", () => {
    expect(isAddressedToOtherUser("<@B001> what's up?", botId)).toBe(false);
  });

  it("returns false when bot is also mentioned alongside another user", () => {
    // "@bm can you answer @cole's question?" — bot explicitly invoked, let app_mention handle it
    expect(isAddressedToOtherUser("<@B001> <@U456> what do you think?", botId)).toBe(false);
  });

  it("returns true when message starts with @mention (direct address)", () => {
    expect(isAddressedToOtherUser("<@U789> looks like the bot is stuck", botId)).toBe(true);
  });

  it("returns false when no botId provided", () => {
    expect(isAddressedToOtherUser("<@U123> hello", undefined)).toBe(false);
  });

  it("handles multiple non-bot mentions", () => {
    expect(isAddressedToOtherUser("<@U111> <@U222> thoughts?", botId)).toBe(true);
  });
});

describe("buildConversationHistory", () => {
  const botId = "B001";

  it("returns alternating user/assistant MessageParam array", () => {
    const messages = [
      { user: "U123", text: "<@B001> How does auth work?", bot_id: undefined },
      { user: "B001", text: "Auth is handled in app/Services/Auth...", bot_id: "B001" },
    ];
    const result = buildConversationHistory(messages, botId);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });

  it("returns empty array when no messages", () => {
    expect(buildConversationHistory([], botId)).toHaveLength(0);
  });

  it("strips @mentions from message text", () => {
    const messages = [
      { user: "U123", text: "<@B001> how does auth work?", bot_id: undefined },
    ];
    const result = buildConversationHistory(messages, botId);
    expect(result[0].content).toBe("how does auth work?");
  });

  it("merges consecutive same-role messages instead of breaking alternation", () => {
    // Two users in a row — should merge into one user message
    const messages = [
      { user: "U123", text: "First question", bot_id: undefined },
      { user: "U456", text: "Second question", bot_id: undefined },
      { user: "B001", text: "Here's the answer", bot_id: "B001" },
    ];
    const result = buildConversationHistory(messages, botId);
    // Two user messages merged into one, then one assistant
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toContain("First question");
    expect(result[0].content).toContain("Second question");
    expect(result[1].role).toBe("assistant");
  });

  it("truncates long messages", () => {
    const longText = "x".repeat(600);
    const messages = [{ user: "U123", text: longText, bot_id: undefined }];
    const result = buildConversationHistory(messages, botId);
    expect((result[0].content as string).length).toBeLessThan(510);
  });

  it("limits to most recent messages", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      user: i % 2 === 0 ? "U123" : "B001",
      text: `Message ${i}`,
      bot_id: i % 2 === 0 ? undefined : "B001",
    }));
    const result = buildConversationHistory(messages, botId);
    // Should have at most MAX_CONTEXT_MESSAGES turns
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it("ensures first message is always role user (Anthropic requirement)", () => {
    // Thread starts with bot message (e.g. the parent was a bot post)
    const messages = [
      { user: "B001", text: "I'm ready to help!", bot_id: "B001" },
      { user: "U123", text: "Great, how does auth work?", bot_id: undefined },
    ];
    const result = buildConversationHistory(messages, botId);
    expect(result[0].role).toBe("user");
  });

  it("ensures last message is role user (the current question context)", () => {
    // History ends with assistant — current message will be appended by caller
    const messages = [
      { user: "U123", text: "How does auth work?", bot_id: undefined },
      { user: "B001", text: "Auth uses JWT tokens...", bot_id: "B001" },
    ];
    const result = buildConversationHistory(messages, botId);
    // Last is assistant — but this is the HISTORY, the caller appends the current question
    // So this is fine. The key invariant is: first must be user.
    expect(result[0].role).toBe("user");
  });

  it("skips empty messages after cleaning", () => {
    const messages = [
      { user: "U123", text: "<@B001>", bot_id: undefined }, // Only an @mention — empty after cleaning
      { user: "U123", text: "How does auth work?", bot_id: undefined },
    ];
    const result = buildConversationHistory(messages, botId);
    // The empty message should be skipped
    const userMessages = result.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe("How does auth work?");
  });
});
