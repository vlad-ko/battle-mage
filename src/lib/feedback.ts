import { kv } from "@vercel/kv";

/**
 * Feedback System — Vercel KV storage
 *
 * Stores 👍/👎 reaction feedback on bot responses.
 * Feedback shapes future answers via the system prompt.
 *
 * Two data structures:
 * 1. "feedback:context:{channel}:{ts}" — stores the Q&A context for each bot message
 * 2. "feedback:entries" — sorted set of feedback entries (like knowledge base)
 */

const CONTEXT_PREFIX = "feedback:context";
const FEEDBACK_KEY = "feedback:entries";
const CONTEXT_TTL = 86400 * 7; // 7 days — after that, reactions are ignored

export interface QAContext {
  question: string;
  answer: string;
  references: string[]; // file paths or issue numbers accessed
}

export interface FeedbackEntry {
  type: "positive" | "negative";
  question: string;
  detail: string; // what worked (positive) or what was wrong (negative)
  timestamp: string;
}

/**
 * Store the Q&A context for a bot message so we can retrieve it on reaction.
 */
export async function storeQAContext(
  channel: string,
  messageTs: string,
  context: QAContext,
): Promise<void> {
  const key = `${CONTEXT_PREFIX}:${channel}:${messageTs}`;
  await kv.set(key, JSON.stringify(context), { ex: CONTEXT_TTL });
}

/**
 * Retrieve the Q&A context for a bot message.
 */
export async function getQAContext(
  channel: string,
  messageTs: string,
): Promise<QAContext | null> {
  const key = `${CONTEXT_PREFIX}:${channel}:${messageTs}`;
  const raw = await kv.get<string>(key);
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : (raw as QAContext);
  } catch {
    return null;
  }
}

/**
 * Save a feedback entry (positive or negative).
 */
export async function saveFeedback(entry: FeedbackEntry): Promise<void> {
  const timestamp = Date.now();
  await kv.zadd(FEEDBACK_KEY, {
    score: timestamp,
    member: JSON.stringify(entry),
  });
}

/**
 * Get all feedback entries formatted as markdown for the system prompt.
 * Returns null if no entries exist.
 */
export async function getFeedbackAsMarkdown(): Promise<string | null> {
  try {
    const raw = await kv.zrange(FEEDBACK_KEY, 0, -1, { rev: true });
    const entries = (raw as string[]).map((item) => {
      try {
        return JSON.parse(item) as FeedbackEntry;
      } catch {
        return null;
      }
    }).filter(Boolean) as FeedbackEntry[];

    if (entries.length === 0) return null;

    // Limit to most recent 30 entries to keep prompt size manageable
    const recent = entries.slice(0, 30);

    const positives = recent.filter((e) => e.type === "positive");
    const negatives = recent.filter((e) => e.type === "negative");

    const lines: string[] = [];

    if (positives.length > 0) {
      lines.push("*What worked well (do more of this):*");
      for (const e of positives) {
        lines.push(`- [${e.timestamp}] Q: "${e.question.slice(0, 80)}" → ${e.detail}`);
      }
    }

    if (negatives.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("*What needed correction (avoid repeating):*");
      for (const e of negatives) {
        lines.push(`- [${e.timestamp}] Q: "${e.question.slice(0, 80)}" → ${e.detail}`);
      }
    }

    return lines.join("\n");
  } catch {
    return null;
  }
}
