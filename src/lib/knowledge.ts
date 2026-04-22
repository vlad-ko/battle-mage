import { kv } from "./kv";

/**
 * Knowledge Base — Vercel KV storage
 *
 * Stores corrections and learned facts from Slack conversations.
 * No GitHub write access needed — all data lives in Vercel KV.
 *
 * Schema: sorted set "knowledge:entries" with score = unix timestamp
 * Each entry is a string like "The auth module lives in app/Services/Auth"
 */

const KNOWLEDGE_KEY = "knowledge:entries";

export interface KnowledgeEntry {
  entry: string;
  timestamp: string; // ISO date (YYYY-MM-DD)
}

/**
 * Save a correction or fact to the knowledge base.
 */
export async function saveKnowledgeEntry(entry: string): Promise<void> {
  const timestamp = Date.now();
  // Store as JSON with date for display
  const value = JSON.stringify({
    entry,
    timestamp: new Date().toISOString().split("T")[0],
  });
  await kv.zadd(KNOWLEDGE_KEY, { score: timestamp, member: value });
}

/**
 * Remove a knowledge entry by matching its entry text.
 * Returns true if the entry was found and removed.
 */
export async function removeKnowledgeEntry(entryText: string): Promise<boolean> {
  const entries = await getAllKnowledge();
  // Find the raw JSON member that matches this entry text
  const raw = await kv.zrange(KNOWLEDGE_KEY, 0, -1);
  for (const member of raw as string[]) {
    try {
      const parsed = JSON.parse(member) as KnowledgeEntry;
      if (parsed.entry === entryText) {
        await kv.zrem(KNOWLEDGE_KEY, member);
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Get all knowledge entries, newest first.
 */
export async function getAllKnowledge(): Promise<KnowledgeEntry[]> {
  const raw = await kv.zrange(KNOWLEDGE_KEY, 0, -1, { rev: true });
  return (raw as string[]).map((item) => {
    try {
      return JSON.parse(item) as KnowledgeEntry;
    } catch {
      // Legacy string entry (shouldn't happen but be safe)
      return { entry: String(item), timestamp: "unknown" };
    }
  });
}

/**
 * Format all knowledge entries as markdown for the system prompt.
 * Returns null if no entries exist.
 */
export async function getKnowledgeAsMarkdown(): Promise<string | null> {
  try {
    const entries = await getAllKnowledge();
    if (entries.length === 0) return null;
    return entries.map((e) => `- [${e.timestamp}] ${e.entry}`).join("\n");
  } catch {
    // KV not configured (local dev without Vercel KV) — skip silently
    return null;
  }
}
