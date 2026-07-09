import { describe, it, expect } from "vitest";
import {
  RECORD_BLOCKLISTED_GITHUB_FNS,
  syntheticCreateIssueResponse,
  assertRecordAllowed,
} from "./cassette";

// Invariant I6/I7 safety pieces — these MUST hold before any recording
// session is allowed to run (see scenario.ts record mode).

describe("record-mode write blocklist (I6)", () => {
  it("blocklists createIssue so recording can never write to the real repo", () => {
    expect(RECORD_BLOCKLISTED_GITHUB_FNS.has("createIssue")).toBe(true);
  });

  it("does not blocklist read-only functions", () => {
    for (const fn of ["readFile", "searchCode", "listIssues", "getHeadSha"]) {
      expect(RECORD_BLOCKLISTED_GITHUB_FNS.has(fn), fn).toBe(false);
    }
  });

  it("synthesizes a createIssue response shaped like the real one", () => {
    const r = syntheticCreateIssueResponse(9001, "Fix flaky sweep test", {
      owner: "acme",
      repo: "backend",
    });
    expect(r).toEqual({
      number: 9001,
      title: "Fix flaky sweep test",
      url: "https://github.com/acme/backend/issues/9001",
    });
  });
});

describe("record-mode CI guard (I7)", () => {
  it("blocks RECORD=1 under any truthy CI value", () => {
    expect(() => assertRecordAllowed({ RECORD: "1", CI: "1" })).toThrow(/refus/i);
    expect(() => assertRecordAllowed({ RECORD: "1", CI: "true" })).toThrow(/refus/i);
  });

  it("replay mode is always allowed, CI or not", () => {
    expect(() => assertRecordAllowed({ CI: "true" })).not.toThrow();
    expect(() => assertRecordAllowed({})).not.toThrow();
  });
});
