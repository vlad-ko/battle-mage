import { randomUUID } from "crypto";
import { kv } from "./kv";
import { log } from "./logger";
import { vectorUpsert, vectorDelete, vectorQuery, kbNamespace } from "./vector";
import {
  RECALL_TOP_K,
  MAX_ARM_RESULTS,
  fuseRankedLists,
  lexicalRank,
  type RecallCandidate,
} from "./retrieval";

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
 *
 * Also embeds the entry into the KB vector namespace (best-effort, #127):
 * vectorUpsert is non-throwing by contract, but the guard below means
 * even a contract violation can never lose the save — KV is the source
 * of truth, the vector index is only a recall accelerator.
 */
export async function saveKnowledgeEntry(entry: string): Promise<string> {
  const id = randomUUID();
  const timestamp = todayISO();
  const value = JSON.stringify({ id, entry, timestamp });
  await kv.zadd(KNOWLEDGE_KEY, { score: Date.now(), member: value });
  try {
    await vectorUpsert(kbNamespace(), [{ id, text: entry, metadata: { timestamp } }]);
  } catch {
    // Best-effort — the KV save above already succeeded.
  }
  return id;
}

/**
 * Best-effort removal of a retired entry's vector so it can never
 * resurface through semantic recall. Legacy id-less entries were never
 * embedded (embedding is keyed by id at save time), so they are skipped.
 */
async function removeKnowledgeVector(id: string | undefined): Promise<void> {
  if (!id) return;
  try {
    await vectorDelete(kbNamespace(), [id]);
  } catch {
    // Best-effort — recall filters retired ids anyway (K1 invariant).
  }
}

/**
 * Find a member matching an entry id or exact entry text that `mutate`
 * accepts, and rewrite it in place (zrem + zadd of the mutated JSON,
 * preserving the original score so ordering is stable). Matches that
 * `mutate` rejects (returns null) are skipped, not terminal — duplicate
 * entry texts where the first duplicate is already superseded must not
 * shadow a later visible one. Returns false if no acceptable match
 * exists or the member disappeared between read and remove.
 *
 * On success, returns the rewritten entry's id (when it has one) so
 * retire flows can clean up the entry's vector embedding (#127).
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
): Promise<{ updated: boolean; id?: string }> {
  const raw = await kv.zrange(KNOWLEDGE_KEY, 0, -1);
  for (const rawMember of raw) {
    const parsed = toEntry(rawMember);
    if (!parsed) continue;
    if (parsed.id !== idOrText && parsed.entry !== idOrText) continue;

    const updated = mutate(parsed);
    if (!updated) continue;

    const member = toMemberString(rawMember);
    const score = await kv.zscore(KNOWLEDGE_KEY, member);
    if (score === null) return { updated: false };
    const removed = await kv.zrem(KNOWLEDGE_KEY, member);
    if (removed === 0) return { updated: false };
    await kv.zadd(KNOWLEDGE_KEY, { score, member: JSON.stringify(updated) });
    return { updated: true, id: parsed.id };
  }
  return { updated: false };
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
  const result = await updateEntry(idOrText, (e) =>
    // The id guard prevents self-supersession when a correction's text
    // exactly matches the flagged entry text it replaces.
    isVisible(e) && e.id !== supersededById ? { ...e, supersededById } : null,
  );
  if (result.updated) await removeKnowledgeVector(result.id);
  return result.updated;
}

/**
 * Replace an entry: saves `newEntryText` as a fresh entry and marks the
 * old one superseded by it. Returns the new entry's id, or null (and
 * saves nothing) if no visible entry matches `oldIdOrText`.
 *
 * If a concurrent writer retires the old entry between the visibility
 * check and the mark, the correction still stands (its id is returned)
 * but the history link is lost — logged as knowledge_supersede_link_failed
 * so the gap is observable rather than silent.
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
  const linked = await markKnowledgeSuperseded(oldIdOrText, newId);
  if (!linked) {
    log("knowledge_supersede_link_failed", { newId });
  }
  return newId;
}

/**
 * Soft-delete an entry with a reason. Matches by id or exact entry text.
 */
export async function archiveKnowledgeEntry(
  idOrText: string,
  reason: string,
): Promise<boolean> {
  const result = await updateEntry(idOrText, (e) =>
    isVisible(e) ? { ...e, archivedAt: todayISO(), archivedReason: reason } : null,
  );
  if (result.updated) await removeKnowledgeVector(result.id);
  return result.updated;
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
    return renderEntries(entries);
  } catch {
    // KV not configured (local dev without Vercel KV) — skip silently
    return null;
  }
}

function renderEntries(entries: KnowledgeEntry[]): string {
  const lines = entries.map((e) => `- [${e.timestamp}] ${e.entry}`).join("\n");
  return `${lines}\n\n${STALE_CONTEXT_FOOTER}`;
}

// Recall key for an entry: real id when present, entry text for legacy
// id-less members. The vector arm only ever returns real ids (embedding
// is keyed by id at save time), so the text fallback only feeds the
// lexical arm.
function recallId(e: KnowledgeEntry): string {
  return e.id ?? e.entry;
}

/**
 * Hybrid top-k recall (#127): render the RECALL_TOP_K visible entries
 * most relevant to `question` instead of dumping the whole KB into the
 * prompt.
 *
 * - 0 visible entries → null.
 * - ≤ RECALL_TOP_K entries → render all; neither arm runs (no vector
 *   call — the full KB already fits the budget).
 * - Otherwise fuse a lexical arm (lexicalRank over visible entries)
 *   with a semantic arm (vectorQuery on the KB namespace) via RRF with
 *   freshness tie-breaks, capped at RECALL_TOP_K. No padding when the
 *   fused set is smaller.
 * - K1 invariant: vector ids are mapped back through the visible set
 *   fetched in THIS call — retired (superseded/archived) or unknown ids
 *   never surface, even if their embeddings still exist.
 * - Both arms empty → fall back to the newest RECALL_TOP_K entries.
 * - Non-throwing: any failure degrades to null (section omitted).
 */
export async function getKnowledgeRecallAsMarkdown(question: string): Promise<string | null> {
  try {
    const entries = await getAllKnowledge(); // visible only, newest first
    if (entries.length === 0) return null;
    if (entries.length <= RECALL_TOP_K) return renderEntries(entries);

    const byId = new Map<string, KnowledgeEntry>();
    for (const e of entries) byId.set(recallId(e), e);

    const candidates: RecallCandidate[] = entries.map((e) => ({
      id: recallId(e),
      text: e.entry,
      timestamp: e.timestamp,
    }));
    const lexicalIds = lexicalRank(question, candidates);

    const matches = await vectorQuery(kbNamespace(), question, MAX_ARM_RESULTS);
    // K1: only ids present in the visible set may surface.
    const semanticIds = (matches ?? [])
      .map((m) => m.id)
      .filter((id) => byId.has(id));

    if (lexicalIds.length === 0 && semanticIds.length === 0) {
      return renderEntries(entries.slice(0, RECALL_TOP_K));
    }

    const timestamps: Record<string, string> = {};
    for (const [id, e] of byId) timestamps[id] = e.timestamp;
    const fused = fuseRankedLists(lexicalIds, semanticIds, {
      timestamps,
      topK: RECALL_TOP_K,
    });
    const selected = fused
      .map((f) => byId.get(f.id))
      .filter((e): e is KnowledgeEntry => e !== undefined);
    return renderEntries(selected);
  } catch {
    // KV not configured or arm failure — omit the section rather than
    // break the turn.
    return null;
  }
}
