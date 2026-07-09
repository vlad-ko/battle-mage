import { describe, it, expect } from "vitest";
import {
  normalizeKbText,
  kbCandidateHash,
  gateKbCandidates,
  matchContradictedEntries,
  isExtractableChannel,
  KB_CANDIDATE_MIN_CONFIDENCE,
  MAX_KB_ENTRY_CHARS,
  KB_SAVED_CONFIRMATION_PREFIX,
} from "./kb-gate";
import type { KbCandidate, TranscriptEntry } from "./kb-extract";
import type { KnowledgeEntry } from "./knowledge";

// Pinned fixtures — stable literals, no faker, no clock.
const T: TranscriptEntry[] = [
  { index: 0, author: "human", ts: "1751970000.000100", text: "how does auth work?" },
  { index: 1, author: "bot",   ts: "1751970060.000200", text: "Auth uses JWT in app/Http/Auth." },
  { index: 2, author: "human", ts: "1751970120.000300", text: "wrong — auth moved to app/Services/Auth last quarter" },
  { index: 3, author: "bot",   ts: "1751970180.000400", text: `${KB_SAVED_CONFIRMATION_PREFIX} _"The rate limit is 120 req/min"_` },
];

const BASE: KbCandidate = {
  entry: "The auth module lives in app/Services/Auth, not app/Http/Auth",
  kind: "correction",
  evidence: [1, 2],
  confidence: 0.9,
};

function gate(overrides: Partial<Parameters<typeof gateKbCandidates>[0]> = {}) {
  return gateKbCandidates({
    candidates: [BASE],
    transcript: T,
    visibleKb: [],
    alreadyProposedHashes: [],
    ...overrides,
  });
}

describe("normalizeKbText", () => {
  it("lowercases, strips punctuation, collapses whitespace, trims", () => {
    expect(normalizeKbText("  The API   limit is 120!! ")).toBe("the api limit is 120");
  });
  it("maps a punctuation-only string to empty", () => {
    expect(normalizeKbText("?!.,;")).toBe("");
  });
});

describe("kbCandidateHash", () => {
  it("is deterministic and normalization-insensitive", () => {
    expect(kbCandidateHash("The API limit is 120")).toBe(kbCandidateHash("  the api limit is 120!! "));
  });
  it("differs for different facts", () => {
    expect(kbCandidateHash("limit is 120")).not.toBe(kbCandidateHash("limit is 60"));
  });
});

describe("gateKbCandidates — eligibility", () => {
  it("passes a human-evidenced correction and carries hash + evidence quotes", () => {
    const { eligible, dropped } = gate();
    expect(dropped).toEqual([]);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].hash).toBe(kbCandidateHash(BASE.entry));
    expect(eligible[0].evidenceQuotes).toHaveLength(2);
    expect(eligible[0].evidenceQuotes[1]).toContain("app/Services/Auth");
  });

  it("correction-shaped evidence (human contradicting bot) is eligible via its human index", () => {
    const { eligible } = gate({ candidates: [{ ...BASE, evidence: [1, 2] }] });
    expect(eligible).toHaveLength(1);
  });
});

describe("gateKbCandidates — drop reasons", () => {
  it("drops empty_entry (whitespace-only)", () => {
    const { eligible, dropped } = gate({ candidates: [{ ...BASE, entry: "   " }] });
    expect(eligible).toEqual([]);
    expect(dropped[0].reason).toBe("empty_entry");
  });

  it("drops entry_too_long above the cap; exactly MAX passes", () => {
    const atCap = gate({ candidates: [{ ...BASE, entry: "x".repeat(MAX_KB_ENTRY_CHARS) }] });
    expect(atCap.eligible).toHaveLength(1);
    const over = gate({ candidates: [{ ...BASE, entry: "x".repeat(MAX_KB_ENTRY_CHARS + 1) }] });
    expect(over.dropped[0].reason).toBe("entry_too_long");
  });

  it("drops low_confidence below threshold; exactly threshold passes (>= semantics)", () => {
    expect(gate({ candidates: [{ ...BASE, confidence: KB_CANDIDATE_MIN_CONFIDENCE }] }).eligible).toHaveLength(1);
    expect(gate({ candidates: [{ ...BASE, confidence: 0.74 }] }).dropped[0].reason).toBe("low_confidence");
  });

  it("drops no_evidence on an empty evidence array", () => {
    expect(gate({ candidates: [{ ...BASE, evidence: [] }] }).dropped[0].reason).toBe("no_evidence");
  });

  it("drops evidence_out_of_range fail-closed: one bad index kills the candidate", () => {
    for (const bad of [[2, 4], [-1, 2], [2, 1.5]]) {
      const { eligible, dropped } = gate({ candidates: [{ ...BASE, evidence: bad as number[] }] });
      expect(eligible).toEqual([]);
      expect(dropped[0].reason).toBe("evidence_out_of_range");
    }
  });

  it("drops no_human_evidence for bot-only-sourced claims", () => {
    const { dropped } = gate({ candidates: [{ ...BASE, evidence: [1, 3] }] });
    expect(dropped[0].reason).toBe("no_human_evidence");
  });

  it("drops already_saved_in_thread when a bot saved-confirmation covers the candidate", () => {
    const { dropped } = gate({
      candidates: [{ ...BASE, entry: "The rate limit is 120 req/min", kind: "fact", evidence: [2] }],
    });
    expect(dropped[0].reason).toBe("already_saved_in_thread");
  });

  it("drops duplicate_kb on normalized exact match against a visible entry", () => {
    const kb: KnowledgeEntry[] = [{ id: "k1", entry: "the auth module lives in app/services/auth, not app/http/auth", timestamp: "2026-07-01" }];
    expect(gate({ visibleKb: kb }).dropped[0].reason).toBe("duplicate_kb");
  });

  it("drops duplicate_kb on normalized containment (either direction)", () => {
    const kb: KnowledgeEntry[] = [{ id: "k1", entry: "Note: the auth module lives in app/Services/Auth, not app/Http/Auth (moved Q2).", timestamp: "2026-07-01" }];
    expect(gate({ visibleKb: kb }).dropped[0].reason).toBe("duplicate_kb");
  });

  it("does NOT treat a superseded/archived entry as a duplicate (caller passes visible set only)", () => {
    // Contract note: gateKbCandidates receives the VISIBLE set; retired entries never block re-learning.
    expect(gate({ visibleKb: [] }).eligible).toHaveLength(1);
  });

  it("drops already_proposed when the hash was proposed in a prior quiet period", () => {
    const { dropped } = gate({ alreadyProposedHashes: [kbCandidateHash(BASE.entry)] });
    expect(dropped[0].reason).toBe("already_proposed");
  });

  it("dedups within a single batch: second candidate with the same normalized text drops as already_proposed", () => {
    const twin = { ...BASE, entry: BASE.entry.toUpperCase() + "!" };
    const { eligible, dropped } = gate({ candidates: [BASE, twin] });
    expect(eligible).toHaveLength(1);
    expect(dropped).toEqual([{ candidate: twin, reason: "already_proposed" }]);
  });

  it("applies reasons in pinned precedence: empty_entry wins over no_evidence", () => {
    const { dropped } = gate({ candidates: [{ ...BASE, entry: " ", evidence: [] }] });
    expect(dropped[0].reason).toBe("empty_entry");
  });

  it("low_confidence wins over evidence_out_of_range", () => {
    const { dropped } = gate({ candidates: [{ ...BASE, confidence: 0.1, evidence: [99] }] });
    expect(dropped[0].reason).toBe("low_confidence");
  });
});

describe("gateKbCandidates — #124 composition annotation", () => {
  it("annotates correction-kind candidates with keyword-matched stale KB entries (flaggedKbEntries)", () => {
    const kb: KnowledgeEntry[] = [
      { id: "k1", entry: "Auth uses JWT in app/Http/Auth", timestamp: "2026-06-01" },
      { id: "k2", entry: "Deploys run on Fridays", timestamp: "2026-06-01" },
    ];
    const { eligible } = gate({ visibleKb: kb });
    expect(eligible[0].flaggedKbEntries).toEqual(["Auth uses JWT in app/Http/Auth"]);
  });

  it("never annotates fact-kind candidates", () => {
    const kb: KnowledgeEntry[] = [{ id: "k1", entry: "Auth uses JWT in app/Http/Auth", timestamp: "2026-06-01" }];
    const { eligible } = gate({
      candidates: [{ entry: "CI auth tokens rotate monthly", kind: "fact", evidence: [2], confidence: 0.9 }],
      visibleKb: kb,
    });
    expect(eligible[0].flaggedKbEntries).toEqual([]);
  });
});

describe("matchContradictedEntries", () => {
  it("matches on meaningful keyword overlap, skipping common words", () => {
    const kb: KnowledgeEntry[] = [{ id: "k1", entry: "The rate limit is 60 req/min", timestamp: "2026-06-01" }];
    expect(matchContradictedEntries("The rate limit is 120 req/min, not 60", kb)).toHaveLength(1);
  });
  it("returns [] when nothing overlaps", () => {
    expect(matchContradictedEntries("Deploys run from main", [{ id: "k1", entry: "The rate limit is 60", timestamp: "2026-06-01" }])).toEqual([]);
  });
  it("returns [] for empty KB", () => {
    expect(matchContradictedEntries("anything", [])).toEqual([]);
  });
});

describe("isExtractableChannel", () => {
  it("allows a public channel", () => {
    expect(isExtractableChannel({ is_private: false, is_im: false, is_mpim: false })).toBe(true);
  });
  it.each([
    ["private", { is_private: true, is_im: false, is_mpim: false }],
    ["DM", { is_private: false, is_im: true, is_mpim: false }],
    ["MPIM", { is_private: false, is_im: false, is_mpim: true }],
  ])("rejects a %s conversation", (_label, info) => {
    expect(isExtractableChannel(info)).toBe(false);
  });
});
