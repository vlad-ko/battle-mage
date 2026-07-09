import { randomUUID } from "crypto";
import { kv } from "./kv";

/**
 * Knowledge Base — Vercel KV storage
 *
 * Stores corrections and learned facts from Slack conversations.
 * No GitHub write access needed — all data lives in Vercel KV.
 *
 * Schema: sorted set "knowledge:entries" with score = unix timestamp.
 * Each member is a JSON-encoded KnowledgeEntry. Entries are never
 * deleted on correction — they are superseded (linked to their
 * replacement) or archived (soft-deleted with a reason), so the full
 * history of what was believed and why it changed is preserved. See #124.
 *
 * Legacy members ({entry, timestamp} without id) predate #124 and parse
 * as visible entries; they can be superseded/archived by entry text.
 */

const KNOWLEDGE_KEY = "knowledge:entries";

export interface KnowledgeEntry {
  /** Stable id assigned at save time. Absent on legacy entries. */
  id?: string;
  entry: string;
  timestamp: string; // ISO date (YYYY-MM-DD)
  /** Set when a correction replaced this entry — points at the replacement's id. */
  supersededById?: string;
  /** ISO date the entry was soft-deleted. */
  archivedAt?: string;
  archivedReason?: string;
}

/**
 * Rendered after KB entries in the system prompt so a stale entry never
 * competes head-to-head with fresh repository evidence.
 */
export const STALE_CONTEXT_FOOTER =
  "_Treat these as possibly stale context. Current user instructions and repository evidence take priority._";

function isVisible(e: KnowledgeEntry): boolean {
  return !e.supersededById && !e.archivedAt;
}

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

// @upstash/redis auto-deserializes zrange members: JSON members come back
// as objects, not strings (verified against the live instance, #124).
// Accept both shapes so the code also survives clients/fixtures that
// return raw strings.
function toEntry(raw: unknown): KnowledgeEntry | null {
  if (raw !== null && typeof raw === "object") {
    const e = raw as KnowledgeEntry;
    return typeof e.entry === "string" ? e : null;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as KnowledgeEntry;
      return typeof parsed.entry === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

// The member string to pass to zscore/zrem so it matches the stored
// bytes. JSON.stringify of a deserialized member reproduces the original
// compact encoding (object key order survives the parse round-trip).
function toMemberString(raw: unknown): string {
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

/**
 * Save a correction or fact to the knowledge base.
 * Returns the new entry's id so callers can link supersessions to it.
 */
export async function saveKnowledgeEntry(entry: string): Promise<string> {
  const id = randomUUID();
  const value = JSON.stringify({ id, entry, timestamp: todayISO() });
  await kv.zadd(KNOWLEDGE_KEY, { score: Date.now(), member: value });
  return id;
}

/**
 * Find the member matching an entry id or exact entry text and rewrite
 * it in place (zrem + zadd of the mutated JSON, preserving the original
 * score so ordering is stable). Returns false if no match, if `mutate`
 * rejects the entry (returns null), or if the member disappeared
 * between read and remove.
 *
 * Concurrency: zscore→zrem→zadd is not atomic. The zrem-count guard
 * ensures we never resurrect a member a concurrent writer already
 * rewrote — if zrem removes nothing, we abort instead of zadd-ing a
 * stale copy. Worst case under a race is a skipped update, never a
 * duplicated or revived entry.
 */
async function updateEntry(
  idOrText: string,
  mutate: (e: KnowledgeEntry) => KnowledgeEntry | null,
): Promise<boolean> {
  const raw = await kv.zrange(KNOWLEDGE_KEY, 0, -1);
  for (const rawMember of raw) {
    const parsed = toEntry(rawMember);
    if (!parsed) continue;
    if (parsed.id !== idOrText && parsed.entry !== idOrText) continue;

    const updated = mutate(parsed);
    if (!updated) return false;

    const member = toMemberString(rawMember);
    const score = await kv.zscore(KNOWLEDGE_KEY, member);
    if (score === null) return false;
    const removed = await kv.zrem(KNOWLEDGE_KEY, member);
    if (removed === 0) return false;
    await kv.zadd(KNOWLEDGE_KEY, { score, member: JSON.stringify(updated) });
    return true;
  }
  return false;
}

/**
 * Mark an existing visible entry as superseded by `supersededById`.
 * Matches by id or exact entry text (text supports legacy entries and
 * the 👎 flow, which stores flagged entry texts). Already-superseded or
 * archived entries are left untouched (returns false) so a stale flag
 * can't relink history.
 */
export async function markKnowledgeSuperseded(
  idOrText: string,
  supersededById: string,
): Promise<boolean> {
  return updateEntry(idOrText, (e) =>
    // The id guard prevents self-supersession when a correction's text
    // exactly matches the flagged entry text it replaces.
    isVisible(e) && e.id !== supersededById ? { ...e, supersededById } : null,
  );
}

/**
 * Replace an entry: saves `newEntryText` as a fresh entry and marks the
 * old one superseded by it. Returns the new entry's id, or null (and
 * saves nothing) if no visible entry matches `oldIdOrText`.
 */
export async function supersedeKnowledgeEntry(
  oldIdOrText: string,
  newEntryText: string,
): Promise<string | null> {
  const raw = await kv.zrange(KNOWLEDGE_KEY, 0, -1);
  const target = raw
    .map(toEntry)
    .find(
      (e): e is KnowledgeEntry =>
        e !== null && isVisible(e) && (e.id === oldIdOrText || e.entry === oldIdOrText),
    );
  if (!target) return null;

  const newId = await saveKnowledgeEntry(newEntryText);
  await markKnowledgeSuperseded(oldIdOrText, newId);
  return newId;
}

/**
 * Soft-delete an entry with a reason. Matches by id or exact entry text.
 */
export async function archiveKnowledgeEntry(
  idOrText: string,
  reason: string,
): Promise<boolean> {
  return updateEntry(idOrText, (e) =>
    isVisible(e) ? { ...e, archivedAt: todayISO(), archivedReason: reason } : null,
  );
}

/**
 * All entries — visible, superseded, and archived — newest first.
 */
export async function getKnowledgeHistory(): Promise<KnowledgeEntry[]> {
  const raw = await kv.zrange(KNOWLEDGE_KEY, 0, -1, { rev: true });
  return raw.map(
    (item) => toEntry(item) ?? { entry: String(item), timestamp: "unknown" },
  );
}

/**
 * Get visible knowledge entries (not superseded, not archived), newest first.
 */
export async function getAllKnowledge(): Promise<KnowledgeEntry[]> {
  return (await getKnowledgeHistory()).filter(isVisible);
}

/**
 * Format visible knowledge entries as markdown for the system prompt,
 * ending with the stale-context footer. Returns null if none exist.
 */
export async function getKnowledgeAsMarkdown(): Promise<string | null> {
  try {
    const entries = await getAllKnowledge();
    if (entries.length === 0) return null;
    const lines = entries.map((e) => `- [${e.timestamp}] ${e.entry}`).join("\n");
    return `${lines}\n\n${STALE_CONTEXT_FOOTER}`;
  } catch {
    // KV not configured (local dev without Vercel KV) — skip silently
    return null;
  }
}
