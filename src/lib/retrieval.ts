/**
 * Retrieval primitives — pure functions for hybrid lexical + semantic
 * recall (#127).
 *
 * Two ranked "arms" (a lexical keyword match and a semantic vector
 * match) are fused with Reciprocal Rank Fusion (RRF): each arm
 * contributes 1/(RRF_K + rank) per candidate, so items ranked well in
 * BOTH arms bubble to the top without either arm's raw scores needing
 * to be comparable. A tiny age boost breaks near-ties in favor of
 * fresher entries — sized so it can NEVER flip two adjacently-ranked
 * candidates from the same arm (see AGE_TIER_BOOSTS).
 *
 * Everything in this file is pure and side-effect free — the vector
 * store lives behind src/lib/vector.ts, callers wire the arms together.
 */

/** Standard RRF dampening constant (Cormack et al. use 60). */
export const RRF_K = 60;

/** How many fused entries the KB recall surfaces into the prompt. */
export const RECALL_TOP_K = 5;

/** Cap per retrieval arm before fusion. */
export const MAX_ARM_RESULTS = 10;

export interface AgeTierBoost {
  /** Inclusive upper bound of the tier, in days. */
  maxAgeDays: number;
  boost: number;
}

/**
 * Freshness tiers. The largest boost (0.00015) is deliberately smaller
 * than the smallest adjacent-rank RRF gap a single arm can produce
 * (1/(RRF_K + MAX_ARM_RESULTS - 1) - 1/(RRF_K + MAX_ARM_RESULTS) ≈
 * 0.000239), so age only ever breaks ties between items whose fused
 * scores are already effectively equal — it never overrides relevance.
 */
export const AGE_TIER_BOOSTS: AgeTierBoost[] = [
  { maxAgeDays: 7, boost: 0.00015 },
  { maxAgeDays: 30, boost: 0.0001 },
  { maxAgeDays: 90, boost: 0.00005 },
];

/** A candidate the lexical arm ranks — id + text + optional ISO date. */
export interface RecallCandidate {
  id: string;
  text: string;
  timestamp?: string;
}

const MS_PER_DAY = 86_400_000;

/**
 * Tiered freshness boost for a timestamp. Age is measured in fractional
 * days from the timestamp's UTC-midnight parse (ISO `YYYY-MM-DD` strings
 * parse as UTC midnight per the ECMAScript date-only rule). Tier
 * boundaries are inclusive; missing or unparseable timestamps (including
 * the legacy "unknown" sentinel) get no boost.
 */
export function ageBoost(timestamp: string | undefined, now: Date = new Date()): number {
  if (!timestamp) return 0;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return 0;
  const ageDays = (now.getTime() - parsed) / MS_PER_DAY;
  for (const tier of AGE_TIER_BOOSTS) {
    if (ageDays <= tier.maxAgeDays) return tier.boost;
  }
  return 0;
}

export interface FusedResult {
  id: string;
  score: number;
}

export interface FuseOptions {
  /** id → ISO date; ids without an entry get no age boost. */
  timestamps?: Record<string, string | undefined>;
  /** Injectable clock for deterministic tests. */
  now?: Date;
  /** Result cap; defaults to RECALL_TOP_K. Explicit 0 is honored. */
  topK?: number;
}

/**
 * Reciprocal Rank Fusion over two ranked id lists.
 *
 * score(id) = Σ over arms of 1/(RRF_K + rank) — ranks are 1-based, and
 * duplicate ids WITHIN one arm keep only their best (first) rank —
 * plus the age boost for the id's timestamp (if provided).
 *
 * Sorting is a stable descending sort, so exact ties keep enumeration
 * order: lexical-arm candidates first, then semantic-only candidates in
 * semantic order.
 */
export function fuseRankedLists(
  lexicalIds: string[],
  semanticIds: string[],
  options?: FuseOptions,
): FusedResult[] {
  const topK = options?.topK ?? RECALL_TOP_K;
  const now = options?.now ?? new Date();

  // Enumeration order (lexical first) determines tie order after the
  // stable sort below.
  const rrfScores = new Map<string, number>();
  for (const arm of [lexicalIds, semanticIds]) {
    const seen = new Set<string>();
    let rank = 0;
    for (const id of arm) {
      if (seen.has(id)) continue; // within-arm dedupe keeps best rank
      seen.add(id);
      rank++;
      rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + rank));
    }
  }

  const fused: FusedResult[] = [...rrfScores.entries()].map(([id, rrf]) => ({
    id,
    score: rrf + ageBoost(options?.timestamps?.[id], now),
  }));
  // Array.prototype.sort is stable per ES2019 — ties keep insertion order.
  fused.sort((a, b) => b.score - a.score);
  return fused.slice(0, topK);
}

// Small stopword set — question words and glue that would otherwise
// substring-match almost every entry. Tokens under 3 chars are already
// dropped before this filter applies.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "not", "but", "you", "your",
  "our", "their", "his", "her", "its", "has", "have", "had", "can", "could",
  "should", "would", "will", "does", "did", "with", "this", "that", "these",
  "those", "from", "into", "about", "what", "when", "where", "which", "who",
  "whom", "why", "how",
]);

/**
 * Lexical arm: rank candidates by how many DISTINCT question tokens
 * substring-match their text (case-insensitive). Tokens are lowercase
 * alphanumeric runs of 3+ chars, minus STOPWORDS. Ties break toward the
 * newer timestamp; zero-score candidates are excluded entirely; output
 * is capped at MAX_ARM_RESULTS ids.
 */
export function lexicalRank(question: string, candidates: RecallCandidate[]): string[] {
  const tokens = [
    ...new Set(
      question
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
    ),
  ];
  if (tokens.length === 0) return [];

  return candidates
    .map((c) => {
      const text = c.text.toLowerCase();
      const score = tokens.filter((t) => text.includes(t)).length;
      return { id: c.id, score, timestamp: c.timestamp ?? "" };
    })
    .filter((c) => c.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        // ISO dates compare correctly as strings; missing sorts oldest.
        b.timestamp.localeCompare(a.timestamp),
    )
    .slice(0, MAX_ARM_RESULTS)
    .map((c) => c.id);
}
