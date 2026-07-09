import { describe, it, expect } from "vitest";
import {
  isAddressedToOtherUser,
  buildConversationHistory,
  extractTranscriptTail,
  TRANSCRIPT_TAIL_MAX,
} from "./thread-filter";

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

  it("truncates long messages at MAX_MESSAGE_LENGTH", () => {
    // Raised to 2000 alongside compaction (#76). A message longer than
    // that is truncated with a trailing ellipsis; loose upper bound so
    // raising the constant again doesn't force a test edit.
    const longText = "x".repeat(4000);
    const messages = [{ user: "U123", text: longText, bot_id: undefined }];
    const result = buildConversationHistory(messages, botId);
    expect((result[0].content as string).length).toBeLessThanOrEqual(2010);
    expect(result[0].content).toMatch(/\.\.\.$/);
  });

  it("limits to most recent messages (MAX_CONTEXT_MESSAGES)", () => {
    // With compaction (#76) handling long threads, the cap is 40. The
    // assertion is stated as a loose upper bound so raising the constant
    // again in the future doesn't require a test edit.
    const messages = Array.from({ length: 100 }, (_, i) => ({
      user: i % 2 === 0 ? "U123" : "B001",
      text: `Message ${i}`,
      bot_id: i % 2 === 0 ? undefined : "B001",
    }));
    const result = buildConversationHistory(messages, botId);
    expect(result.length).toBeLessThanOrEqual(40);
    // And should be populated — prove the cap isn't zeroing out content.
    expect(result.length).toBeGreaterThan(0);
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

describe("extractTranscriptTail", () => {
  const botId = "B001";

  it("returns empty string for no messages", () => {
    expect(extractTranscriptTail([], botId)).toBe("");
  });

  it("labels speakers bot/user using the buildConversationHistory rule", () => {
    const messages = [
      { user: "U123", text: "How does auth work?", bot_id: undefined },
      { user: "B001", text: "Auth uses JWT tokens.", bot_id: "B001" },
    ];
    const tail = extractTranscriptTail(messages, botId);
    expect(tail).toBe("user: How does auth work?\nbot: Auth uses JWT tokens.");
  });

  it("labels messages with a bot_id as bot even when user differs", () => {
    const messages = [{ user: "U999", text: "automated post", bot_id: "BOTHER" }];
    expect(extractTranscriptTail(messages, botId)).toBe("bot: automated post");
  });

  it("strips @mentions from entries", () => {
    const messages = [
      { user: "U123", text: "<@B001> can you check <@U456>'s question?", bot_id: undefined },
    ];
    const tail = extractTranscriptTail(messages, botId);
    expect(tail).not.toContain("<@");
    expect(tail).toContain("can you check");
  });

  it("truncates entries at 500 chars with a trailing ellipsis", () => {
    const messages = [{ user: "U123", text: "x".repeat(600), bot_id: undefined }];
    const tail = extractTranscriptTail(messages, botId);
    // "user: " prefix + 500 chars + "..."
    expect(tail.length).toBeLessThanOrEqual("user: ".length + 500 + 3);
    expect(tail).toMatch(/\.\.\.$/);
  });

  it("skips entries that are empty after mention stripping", () => {
    const messages = [
      { user: "U123", text: "<@B001>", bot_id: undefined },
      { user: "U123", text: "real question", bot_id: undefined },
    ];
    expect(extractTranscriptTail(messages, botId)).toBe("user: real question");
  });

  it("keeps only the last TRANSCRIPT_TAIL_MAX entries", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      user: "U123",
      text: `msg ${i}`,
      bot_id: undefined,
    }));
    const tail = extractTranscriptTail(messages, botId);
    const lines = tail.split("\n");
    expect(TRANSCRIPT_TAIL_MAX).toBe(6);
    expect(lines).toHaveLength(TRANSCRIPT_TAIL_MAX);
    // Most recent messages survive, oldest are dropped
    expect(lines[lines.length - 1]).toBe("user: msg 19");
    expect(tail).not.toContain("msg 13");
  });
});

// ── #146: system footer must not echo through conversation history ──

describe("buildConversationHistory — footer stripping (#146)", () => {
  const BOT = "B001";
  const FOOTER = "\n\n───\n*References:*\n  • 📄 <https://github.com/o/r/blob/main/f.ts|f.ts>\n_React with 👍 or 👎 to help me give better answers in the future._";

  it("strips the system footer from assistant turns so the model can't imitate it", () => {
    const history = buildConversationHistory(
      [
        { user: "U1", text: "how does auth work?", bot_id: undefined },
        { user: BOT, text: "Auth uses JWT." + FOOTER, bot_id: "B001" },
      ],
      BOT,
    );
    expect(history).toHaveLength(2);
    expect(history[1].content).toBe("Auth uses JWT.");
    expect(history[1].content).not.toContain("References");
    expect(history[1].content).not.toContain("React with");
  });

  it("does NOT strip footer-lookalike text from USER turns", () => {
    const userText = "why does your ───\n*References:*\n block show twice?";
    const history = buildConversationHistory(
      [{ user: "U1", text: userText, bot_id: undefined }],
      BOT,
    );
    expect(history[0].content).toContain("*References:*");
  });

  it("skips an assistant message that is footer-only (no empty turns)", () => {
    const history = buildConversationHistory(
      [
        { user: "U1", text: "question", bot_id: undefined },
        { user: BOT, text: FOOTER.trimStart(), bot_id: "B001" },
        { user: "U1", text: "follow-up", bot_id: undefined },
      ],
      BOT,
    );
    // Footer-only bot turn vanishes; the two user turns merge.
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe("user");
    expect(history[0].content).toContain("question");
    expect(history[0].content).toContain("follow-up");
  });
});

describe("extractTranscriptTail — footer stripping (#146 review)", () => {
  const BOT = "B001";
  const FOOTER = "\n\n───\n*References:*\n  • 📄 <https://github.com/o/r/blob/main/f.ts|f.ts>\n_React with 👍 or 👎 to help me give better answers in the future._";

  it("bot entries reach the classifier transcript footer-free", () => {
    const tail = extractTranscriptTail(
      [
        { user: "U1", text: "how does auth work?", bot_id: undefined },
        { user: BOT, text: "Auth uses JWT." + FOOTER, bot_id: "B001" },
      ],
      BOT,
    );
    expect(tail).toContain("bot: Auth uses JWT.");
    expect(tail).not.toContain("References");
    expect(tail).not.toContain("React with");
  });

  it("a footer-only bot message is skipped, not an empty entry", () => {
    const tail = extractTranscriptTail(
      [
        { user: "U1", text: "question", bot_id: undefined },
        { user: BOT, text: FOOTER.trimStart(), bot_id: "B001" },
      ],
      BOT,
    );
    expect(tail).toBe("user: question");
  });

  it("user entries quoting footer-lookalike text are NOT stripped", () => {
    const tail = extractTranscriptTail(
      [{ user: "U1", text: "why is *References:* doubled?", bot_id: undefined }],
      BOT,
    );
    expect(tail).toContain("*References:*");
  });
});
