import { describe, it, expect } from "vitest";
import {
  RRF_K,
  RECALL_TOP_K,
  MAX_ARM_RESULTS,
  AGE_TIER_BOOSTS,
  ageBoost,
  fuseRankedLists,
  lexicalRank,
  type RecallCandidate,
} from "./retrieval";

// Pinned clock — no test below may depend on the real current time.
const NOW = new Date("2026-07-08T00:00:00Z");

describe("retrieval constants", () => {
  it("pins the RRF constant and recall sizes", () => {
    expect(RRF_K).toBe(60);
    expect(RECALL_TOP_K).toBe(5);
    expect(MAX_ARM_RESULTS).toBe(10);
  });

  it("age tiers are 7/30/90 days with strictly decreasing boosts", () => {
    expect(AGE_TIER_BOOSTS.map((t) => t.maxAgeDays)).toEqual([7, 30, 90]);
    const boosts = AGE_TIER_BOOSTS.map((t) => t.boost);
    for (let i = 1; i < boosts.length; i++) {
      expect(boosts[i]).toBeLessThan(boosts[i - 1]);
      expect(boosts[i]).toBeGreaterThan(0);
    }
  });

  it("largest boost is near-tie sized: smaller than the smallest single-arm adjacent-rank gap", () => {
    // Deepest rank an arm can contribute is MAX_ARM_RESULTS; the gap
    // between ranks (MAX_ARM_RESULTS - 1) and MAX_ARM_RESULTS is the
    // smallest gap a boost must NOT be able to flip.
    const maxBoost = Math.max(...AGE_TIER_BOOSTS.map((t) => t.boost));
    const smallestGap =
      1 / (RRF_K + MAX_ARM_RESULTS - 1) - 1 / (RRF_K + MAX_ARM_RESULTS);
    expect(maxBoost).toBeLessThan(smallestGap);
  });
});

describe("ageBoost (inclusive tier boundaries, pinned clock)", () => {
  it("0 days old → freshest tier", () => {
    expect(ageBoost("2026-07-08", NOW)).toBe(0.00015);
  });
  it("exactly 7 days old → freshest tier (boundary inclusive)", () => {
    expect(ageBoost("2026-07-01", NOW)).toBe(0.00015);
  });
  it("8 days old → 30d tier", () => {
    expect(ageBoost("2026-06-30", NOW)).toBe(0.0001);
  });
  it("exactly 30 days old → 30d tier (boundary inclusive)", () => {
    expect(ageBoost("2026-06-08", NOW)).toBe(0.0001);
  });
  it("31 days old → 90d tier", () => {
    expect(ageBoost("2026-06-07", NOW)).toBe(0.00005);
  });
  it("exactly 90 days old → 90d tier (boundary inclusive)", () => {
    expect(ageBoost("2026-04-09", NOW)).toBe(0.00005);
  });
  it("91 days old → no boost", () => {
    expect(ageBoost("2026-04-08", NOW)).toBe(0);
  });
  it("missing or unparseable timestamp → no boost", () => {
    expect(ageBoost(undefined, NOW)).toBe(0);
    expect(ageBoost("not-a-date", NOW)).toBe(0);
    expect(ageBoost("unknown", NOW)).toBe(0); // legacy history sentinel
  });
});

describe("fuseRankedLists — reciprocal rank fusion (hand-computed)", () => {
  it("sums 1/(RRF_K + rank) across arms; item ranked high in both arms wins", () => {
    // lexical: a=1, b=2, c=3   semantic: b=1, c=2, a=3
    const fused = fuseRankedLists(["a", "b", "c"], ["b", "c", "a"]);
    // b: 1/62 + 1/61 = 0.032522474881015337
    // a: 1/61 + 1/63 = 0.032266458495966693
    // c: 1/63 + 1/62 = 0.032002048131080388
    expect(fused.map((f) => f.id)).toEqual(["b", "a", "c"]);
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(fused[1].score).toBeCloseTo(1 / 61 + 1 / 63, 12);
    expect(fused[2].score).toBeCloseTo(1 / 63 + 1 / 62, 12);
  });

  it("single-arm item scores exactly 1/(RRF_K + rank)", () => {
    const fused = fuseRankedLists(["x"], []);
    expect(fused).toHaveLength(1);
    expect(fused[0].score).toBeCloseTo(1 / 61, 12);
  });

  it("exact cross-arm tie without timestamps keeps lexical-arm candidate first (deterministic)", () => {
    // a is lexical rank 1, b is semantic rank 1 — identical 1/61 scores.
    const fused = fuseRankedLists(["a"], ["b"]);
    expect(fused.map((f) => f.id)).toEqual(["a", "b"]);
    expect(fused[0].score).toBeCloseTo(fused[1].score, 12);
  });

  it("age boost breaks an exact cross-arm tie in favor of the fresher item", () => {
    const fused = fuseRankedLists(["a"], ["b"], {
      timestamps: { a: "2026-04-08", b: "2026-07-06" }, // a: 91d → +0; b: 2d → +0.00015
      now: NOW,
    });
    expect(fused.map((f) => f.id)).toEqual(["b", "a"]);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 0.00015, 12);
    expect(fused[1].score).toBeCloseTo(1 / 61, 12);
  });

  it("age boost between tiers breaks a same-score tie (7d tier beats 90d tier)", () => {
    const fused = fuseRankedLists(["a"], ["b"], {
      timestamps: { a: "2026-05-20", b: "2026-07-07" }, // a: 49d → +0.00005; b: 1d → +0.00015
      now: NOW,
    });
    expect(fused.map((f) => f.id)).toEqual(["b", "a"]);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 0.00015, 12);
    expect(fused[1].score).toBeCloseTo(1 / 61 + 0.00005, 12);
  });

  it("age boost NEVER flips a single-arm adjacent-rank pair (F2 invariant)", () => {
    // a is rank 1 but stale (>90d, +0); b is rank 2 and fresh (+0.00015).
    // Gap 1/61 - 1/62 ≈ 0.000264 > 0.00015, so a must stay first.
    const fused = fuseRankedLists(["a", "b"], [], {
      timestamps: { a: "2026-01-01", b: "2026-07-07" },
      now: NOW,
    });
    expect(fused.map((f) => f.id)).toEqual(["a", "b"]);
    expect(fused[0].score).toBeCloseTo(1 / 61, 12);
    expect(fused[1].score).toBeCloseTo(1 / 62 + 0.00015, 12);
  });

  it("duplicate ids within one arm keep only the best rank", () => {
    const fused = fuseRankedLists(["a", "a", "b"], []);
    expect(fused.map((f) => f.id)).toEqual(["a", "b"]);
    expect(fused[0].score).toBeCloseTo(1 / 61, 12);
    // b takes rank 2 after dedupe, not rank 3.
    expect(fused[1].score).toBeCloseTo(1 / 62, 12);
  });

  it("empty lexical arm degrades to pure semantic ranking", () => {
    const fused = fuseRankedLists([], ["x", "y"]);
    expect(fused.map((f) => f.id)).toEqual(["x", "y"]);
    expect(fused[0].score).toBeCloseTo(1 / 61, 12);
    expect(fused[1].score).toBeCloseTo(1 / 62, 12);
  });

  it("empty semantic arm degrades to pure lexical ranking", () => {
    const fused = fuseRankedLists(["x", "y"], []);
    expect(fused.map((f) => f.id)).toEqual(["x", "y"]);
  });

  it("both arms empty → empty result", () => {
    expect(fuseRankedLists([], [])).toEqual([]);
  });

  it("caps output at RECALL_TOP_K by default", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const fused = fuseRankedLists(ids, []);
    expect(fused).toHaveLength(RECALL_TOP_K);
    expect(fused.map((f) => f.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("honors an explicit topK, including 0", () => {
    expect(fuseRankedLists(["a", "b", "c"], [], { topK: 2 })).toHaveLength(2);
    expect(fuseRankedLists(["a", "b", "c"], [], { topK: 0 })).toEqual([]);
  });

  it("ids without a timestamps entry get no boost (no NaN leakage)", () => {
    const fused = fuseRankedLists(["a"], [], {
      timestamps: { somebodyElse: "2026-07-07" },
      now: NOW,
    });
    expect(fused[0].score).toBeCloseTo(1 / 61, 12);
    expect(Number.isFinite(fused[0].score)).toBe(true);
  });
});

describe("lexicalRank", () => {
  const candidates: RecallCandidate[] = [
    { id: "k1", text: "The Redis KV wrapper lives in src/lib/kv.ts", timestamp: "2026-06-01" },
    { id: "k2", text: "Deploys go through Vercel, never Cloud Run", timestamp: "2026-05-01" },
    { id: "k3", text: "The redis client is @upstash/redis behind the kv.ts wrapper", timestamp: "2026-07-01" },
  ];

  it("ranks by distinct matched tokens; ties broken by newer timestamp", () => {
    // "redis" and "wrapper" match k1 and k3 equally → newer k3 first.
    const ranked = lexicalRank("where is the redis wrapper", candidates);
    expect(ranked).toEqual(["k3", "k1"]);
  });

  it("excludes zero-score candidates entirely", () => {
    const ranked = lexicalRank("redis wrapper", candidates);
    expect(ranked).not.toContain("k2");
  });

  it("matching is case-insensitive", () => {
    const ranked = lexicalRank("REDIS Wrapper", candidates);
    expect(ranked).toEqual(["k3", "k1"]);
  });

  it("more distinct matched tokens outranks fewer, regardless of recency", () => {
    const ranked = lexicalRank("vercel cloud run deploys", candidates);
    // k2 matches vercel+cloud+run+deploys; nothing else matches ≥1 token better.
    expect(ranked[0]).toBe("k2");
  });

  it("stopwords like 'the' do not count as matches", () => {
    // Both k1 and k3 contain "The"/"the"; a stopword-only question matches nothing.
    expect(lexicalRank("the", candidates)).toEqual([]);
  });

  it("empty question → empty result", () => {
    expect(lexicalRank("", candidates)).toEqual([]);
    expect(lexicalRank("   ", candidates)).toEqual([]);
  });

  it("caps at MAX_ARM_RESULTS", () => {
    const many: RecallCandidate[] = Array.from({ length: 15 }, (_, i) => ({
      id: `id${i}`,
      text: `vercel deployment note ${i}`,
      timestamp: "2026-06-01",
    }));
    expect(lexicalRank("vercel deployment", many)).toHaveLength(MAX_ARM_RESULTS);
  });

  it('legacy "unknown" timestamps lose ties to real ISO dates (#127 review)', () => {
    // "unknown" > "2026-..." as a raw string — the tie-break must coerce
    // non-ISO timestamps to the OLDEST bucket, not let them win.
    const cands: RecallCandidate[] = [
      { id: "legacy", text: "vercel deploy fact", timestamp: "unknown" },
      { id: "dated", text: "vercel deploy note", timestamp: "2026-01-01" },
    ];
    expect(lexicalRank("vercel deploy", cands)).toEqual(["dated", "legacy"]);
  });
});
