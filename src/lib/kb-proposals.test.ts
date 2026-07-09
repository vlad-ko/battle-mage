import { describe, it, expect } from "vitest";
import {
  decideKbExtraction,
  escapeSlackMentions,
  formatKbProposalMessage,
  summarizeKbSaveResult,
  kbStateKey,
  kbClaimKey,
  kbBatchKey,
  kbBatchThreadPointerKey,
  kbBatchTombstoneKey,
  KB_EXTRACT_INDEX_KEY,
  KB_EXTRACT_IDLE_MS,
  MAX_KB_EXTRACTION_ATTEMPTS,
  type KbThreadState,
} from "./kb-proposals";
import { SINGLE_PROPOSAL_ANCHOR, BATCH_PROPOSAL_HEADER } from "./issue-batch";
import type { EligibleKbCandidate } from "./kb-gate";

// Pinned clock values — no Date.now() anywhere in these tests.
const NOW = 1_752_000_000_000;
const IDLE = KB_EXTRACT_IDLE_MS;
const covered = (over: Partial<KbThreadState> = {}): KbThreadState => ({
  status: "covered", extractedAt: NOW - 2 * IDLE, attempt: 0, proposedHashes: [], ...over,
});

describe("key builders", () => {
  it("build namespaced keys", () => {
    expect(KB_EXTRACT_INDEX_KEY).toBe("kb-extract:index");
    expect(kbStateKey("C1", "17.1")).toBe("kb-extract:state:C1:17.1");
    expect(kbClaimKey("C1", "17.1")).toBe("kb-extract:claim:C1:17.1");
    expect(kbBatchKey("C1", "17.2")).toBe("pending-kb-batch:C1:17.2");
    expect(kbBatchThreadPointerKey("C1", "17.1")).toBe("pending-kb-batch:thread:C1:17.1");
    expect(kbBatchTombstoneKey("C1", "17.2")).toBe("pending-kb-batch:done:C1:17.2");
  });
});

describe("decideKbExtraction — idle gate", () => {
  it("waits while activity is recent (age < idle)", () => {
    expect(decideKbExtraction(null, NOW - IDLE + 1, NOW)).toBe("wait");
  });
  it("waits at exactly the idle boundary (age === idle → wait; strict > required to extract)", () => {
    expect(decideKbExtraction(null, NOW - IDLE, NOW)).toBe("wait");
  });
  it("extracts one ms past the boundary", () => {
    expect(decideKbExtraction(null, NOW - IDLE - 1, NOW)).toBe("extract");
  });
  it("waits on a FUTURE activity score (clock skew must never trigger extraction)", () => {
    expect(decideKbExtraction(null, NOW + 60_000, NOW)).toBe("wait");
  });
});

describe("decideKbExtraction — state transitions", () => {
  const IDLE_ACTIVITY = NOW - 2 * IDLE; // comfortably past idle

  it("extracts a never-extracted idle thread (null state)", () => {
    expect(decideKbExtraction(null, IDLE_ACTIVITY, NOW)).toBe("extract");
  });
  it("prunes a covered thread with no activity since extraction (extractedAt >= lastActivityAt)", () => {
    expect(decideKbExtraction(covered({ extractedAt: IDLE_ACTIVITY }), IDLE_ACTIVITY, NOW)).toBe("prune");
    expect(decideKbExtraction(covered({ extractedAt: IDLE_ACTIVITY + 5 }), IDLE_ACTIVITY, NOW)).toBe("prune");
  });
  it("re-extracts a covered thread after NEW activity + a fresh quiet period (at most once PER quiet period)", () => {
    expect(decideKbExtraction(covered({ extractedAt: NOW - 3 * IDLE }), IDLE_ACTIVITY, NOW)).toBe("extract");
  });
  it("retries a failed thread below the attempt cap", () => {
    expect(
      decideKbExtraction(covered({ status: "failed", attempt: MAX_KB_EXTRACTION_ATTEMPTS - 1 }), IDLE_ACTIVITY, NOW),
    ).toBe("extract");
  });
  it("gives up at exactly the attempt cap (>= semantics)", () => {
    expect(
      decideKbExtraction(covered({ status: "failed", attempt: MAX_KB_EXTRACTION_ATTEMPTS }), IDLE_ACTIVITY, NOW),
    ).toBe("give_up");
  });
  it("prunes a gave_up thread with no new activity", () => {
    expect(decideKbExtraction(covered({ status: "gave_up", extractedAt: IDLE_ACTIVITY }), IDLE_ACTIVITY, NOW)).toBe("prune");
  });
  it("re-arms a gave_up thread when new activity arrives", () => {
    expect(decideKbExtraction(covered({ status: "gave_up", extractedAt: NOW - 3 * IDLE }), IDLE_ACTIVITY, NOW)).toBe("extract");
  });
});

describe("formatKbProposalMessage", () => {
  const C: EligibleKbCandidate = {
    entry: "The auth module lives in app/Services/Auth",
    kind: "correction",
    evidence: [2],
    confidence: 0.9,
    hash: "abc123",
    flaggedKbEntries: ["Auth uses JWT in app/Http/Auth"],
    evidenceQuotes: ["wrong — auth moved to app/Services/Auth last quarter"],
  };

  it("returns empty string for zero candidates (empty fan-out posts nothing)", () => {
    expect(formatKbProposalMessage([])).toBe("");
  });
  it("renders a numbered list with entry text, kind, and evidence quote", () => {
    const msg = formatKbProposalMessage([C, { ...C, entry: "Deploys run from main", kind: "fact", flaggedKbEntries: [] }]);
    expect(msg).toContain("1. ");
    expect(msg).toContain("2. ");
    expect(msg).toContain("The auth module lives in app/Services/Auth");
    expect(msg).toContain("wrong — auth moved to app/Services/Auth last quarter");
    expect(msg).toContain("correction");
  });
  it("includes the confirm instruction (✅ or confirm all)", () => {
    const msg = formatKbProposalMessage([C]);
    expect(msg).toContain(":white_check_mark:");
    expect(msg).toContain("confirm all");
  });
  it("NEVER contains the issue-proposal anchors — the legacy ✅ parser must not match a KB proposal", () => {
    const msg = formatKbProposalMessage([C]);
    expect(msg).not.toContain(SINGLE_PROPOSAL_ANCHOR);
    expect(msg).not.toContain(BATCH_PROPOSAL_HEADER);
  });
});

describe("escapeSlackMentions", () => {
  it("escapes & FIRST, then < and > (pre-existing entities double-escape predictably)", () => {
    expect(escapeSlackMentions("a & b")).toBe("a &amp; b");
    expect(escapeSlackMentions("&lt;")).toBe("&amp;lt;");
    expect(escapeSlackMentions("a < b > c & d")).toBe("a &lt; b &gt; c &amp; d");
  });
  it("neutralizes every Slack control sequence", () => {
    expect(escapeSlackMentions("<!channel> <!here> <@U123> <#C42|general>")).toBe(
      "&lt;!channel&gt; &lt;!here&gt; &lt;@U123&gt; &lt;#C42|general&gt;",
    );
  });
  it("leaves plain text untouched", () => {
    expect(escapeSlackMentions("The auth module lives in app/Services/Auth")).toBe(
      "The auth module lives in app/Services/Auth",
    );
  });
});

describe("formatKbProposalMessage — mention-token escaping", () => {
  const HOSTILE: EligibleKbCandidate = {
    entry: "Ping <!channel> when deploys fail",
    kind: "correction",
    evidence: [1],
    confidence: 0.9,
    hash: "h1",
    flaggedKbEntries: ["Notify <!here> on rollback"],
    evidenceQuotes: ["ask <@U123> about the deploy pings"],
  };

  it("renders entry, quotes, and flagged entries with escaped tokens — no raw control sequences", () => {
    const msg = formatKbProposalMessage([HOSTILE]);
    expect(msg).not.toContain("<!channel>");
    expect(msg).not.toContain("<@U123>");
    expect(msg).not.toContain("<!here>");
    expect(msg).toContain("&lt;!channel&gt;");
    expect(msg).toContain("&lt;@U123&gt;");
    expect(msg).toContain("&lt;!here&gt;");
  });
});

describe("summarizeKbSaveResult — mention-token escaping", () => {
  it("escapes model-produced entry text in both saved and failed lines", () => {
    const msg = summarizeKbSaveResult([
      { status: "saved", entry: "Ping <!channel> on deploys", id: "id-1", supersededCount: 0 },
      { status: "error", entry: "Ask <@U123> first", errorMessage: "kv down" },
    ]);
    expect(msg).not.toContain("<!channel>");
    expect(msg).not.toContain("<@U123>");
    expect(msg).toContain("&lt;!channel&gt;");
    expect(msg).toContain("&lt;@U123&gt;");
  });
});

describe("summarizeKbSaveResult", () => {
  it("returns empty string for no outcomes", () => {
    expect(summarizeKbSaveResult([])).toBe("");
  });
  it("lists saved entries with the superseded count and failures with their errors", () => {
    const msg = summarizeKbSaveResult([
      { status: "saved", entry: "The auth module lives in app/Services/Auth", id: "id-1", supersededCount: 1 },
      { status: "error", entry: "Deploys run from main", errorMessage: "kv down" },
    ]);
    expect(msg).toContain("Saved 1");
    expect(msg).toContain("app/Services/Auth");
    expect(msg).toContain("retired 1");
    expect(msg).toContain("kv down");
  });
});
