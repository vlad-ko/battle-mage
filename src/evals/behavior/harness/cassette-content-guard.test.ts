import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Cassette content tripwire ────────────────────────────────────────
// battle-mage (this repo) is PUBLIC; its production deployment targets
// the PRIVATE wealthbot-io/webo repo. Recording cassettes from a machine
// whose env points at production would embed private-repo content
// (CLAUDE.md, repo tree, file bodies) inside the recorded prompts — and
// committing those cassettes would publish it. This happened once and
// was caught pre-push; this test makes the mistake impossible to repeat
// silently. Runs under `npm test` (harness dir), so CI blocks the merge.
//
// Cassettes MUST be recorded self-referentially against the public repo:
//   GITHUB_OWNER=vlad-ko GITHUB_REPO=battle-mage
//
// Known caveat: two PUBLIC battle-mage sources legitimately mention the
// production repo in comments (src/lib/repo-index.ts:169,
// sentry.server.config.ts:33). A future cassette whose recording READS
// those files would trip this guard falsely — that failure mode is
// conservative and loud: adjust the scenario (or this guard) explicitly
// rather than weakening the tripwire.

const CASSETTES_DIR = fileURLToPath(new URL("../cassettes/", import.meta.url));
const FORBIDDEN = /wealthbot|webo/i;

function listCassettes(): string[] {
  if (!fs.existsSync(CASSETTES_DIR)) return [];
  return fs
    .readdirSync(CASSETTES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

describe("cassette content guard (private-repo tripwire)", () => {
  it("no cassette contains private-repo identifiers (wealthbot / webo)", () => {
    for (const file of listCassettes()) {
      const content = fs.readFileSync(path.join(CASSETTES_DIR, file), "utf8");
      const match = content.match(FORBIDDEN);
      expect(
        match,
        `${file} contains forbidden string "${match?.[0]}" — it was recorded ` +
          `against the PRIVATE production repo. Purge it and re-record ` +
          `self-referentially: GITHUB_OWNER=vlad-ko GITHUB_REPO=battle-mage ` +
          `RECORD=1 npm run eval:behavior`,
      ).toBeNull();
    }
  });

  it("every cassette is pinned to the public repo in its env meta", () => {
    for (const file of listCassettes()) {
      const cassette = JSON.parse(
        fs.readFileSync(path.join(CASSETTES_DIR, file), "utf8"),
      ) as { env?: { GITHUB_OWNER?: string; GITHUB_REPO?: string } };
      expect(cassette.env?.GITHUB_OWNER, `${file} env.GITHUB_OWNER`).toBe("vlad-ko");
      expect(cassette.env?.GITHUB_REPO, `${file} env.GITHUB_REPO`).toBe("battle-mage");
    }
  });
});
