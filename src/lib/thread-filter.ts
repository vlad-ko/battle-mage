/**
 * Thread message filtering — pure functions for deciding whether
 * BM should respond to a thread follow-up message, and for building
 * proper multi-turn conversation history from Slack thread messages.
 */

const MENTION_RE = /<@([A-Z0-9]+)>/g;

/**
 * Returns true if the message @mentions a specific user who is NOT the bot.
 * When a user writes "@vlad can you check this?", BM should stay silent.
 */
export function isAddressedToOtherUser(
  text: string,
  botUserId: string | undefined,
): boolean {
  if (!botUserId) return false;

  const mentions = [...text.matchAll(MENTION_RE)].map((m) => m[1]);
  if (mentions.length === 0) return false;

  return mentions.some((id) => id !== botUserId);
}

// ── Conversation history builder ────────────────────────────────────

export interface ThreadMessage {
  user?: string;
  text?: string;
  bot_id?: string;
}

export interface MessageParam {
  role: "user" | "assistant";
  content: string;
}

const MAX_CONTEXT_MESSAGES = 10;
const MAX_MESSAGE_LENGTH = 500;

function cleanText(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

/**
 * Builds proper alternating user/assistant message history from a Slack thread.
 *
 * This uses the Anthropic-native multi-turn format instead of string-hacking
 * context into a single message. The result can be prepended to the messages
 * array in runAgent().
 *
 * Key invariants:
 * - First message is always role: "user" (Anthropic requirement)
 * - Consecutive same-role messages are merged (Anthropic requirement)
 * - Empty messages (after @mention stripping) are skipped
 * - Capped at MAX_CONTEXT_MESSAGES most recent entries
 */
export function buildConversationHistory(
  messages: ThreadMessage[],
  botUserId: string,
): MessageParam[] {
  if (messages.length === 0) return [];

  // Take the most recent messages
  const recent = messages.slice(-MAX_CONTEXT_MESSAGES);

  // Build raw turns with cleaned text
  const rawTurns: MessageParam[] = [];
  for (const m of recent) {
    const text = truncate(cleanText(m.text ?? ""), MAX_MESSAGE_LENGTH);
    if (!text) continue; // Skip empty messages

    const role: "user" | "assistant" =
      m.user === botUserId || m.bot_id ? "assistant" : "user";
    rawTurns.push({ role, content: text });
  }

  if (rawTurns.length === 0) return [];

  // Merge consecutive same-role messages (Anthropic requires strict alternation)
  const merged: MessageParam[] = [rawTurns[0]];
  for (let i = 1; i < rawTurns.length; i++) {
    const prev = merged[merged.length - 1];
    if (rawTurns[i].role === prev.role) {
      prev.content += "\n" + rawTurns[i].content;
    } else {
      merged.push(rawTurns[i]);
    }
  }

  // Ensure first message is user (Anthropic requirement)
  // If thread starts with assistant, drop it
  while (merged.length > 0 && merged[0].role === "assistant") {
    merged.shift();
  }

  return merged;
}
