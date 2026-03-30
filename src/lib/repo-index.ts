import { kv } from "@vercel/kv";

// ── Topic classification rules ───────────────────────────────────────
// Each rule: [topic, pattern that matches against file path (case-insensitive)]

const TOPIC_RULES: [string, RegExp][] = [
  ["authentication", /\bauth|login|session|oauth|jwt|token|password|credential/i],
  ["deployment", /dockerfile|docker-compose|deploy|\.github\/workflows\/deploy|cloud.?run|kubernetes|k8s|helm/i],
  ["database", /migration|schema|database|seed|\.sql$|models?\//i],
  ["testing", /\btests?\b|\.test\.|\.spec\.|__tests__|phpunit|jest|vitest/i],
  ["documentation", /\.md$|docs?\//i],
  ["ci-cd", /\.github\/workflows\/|\.circleci|\.gitlab-ci|jenkinsfile|buildkite/i],
  ["api", /routes?\b|controller|endpoint|api\//i],
  ["configuration", /config\/|\.env|docker-compose|\.ya?ml$|\.json$/i],
];

const IGNORED_PREFIXES = ["vendor/", "node_modules/", ".git/", "dist/", "build/"];

// ── Pure functions (exported for testing) ─────────────────────────────

export type TopicMap = Record<string, string[]>;

export function classifyTopics(paths: string[]): TopicMap {
  const topics: TopicMap = {};

  for (const path of paths) {
    // Skip vendored/generated files
    if (IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;

    for (const [topic, pattern] of TOPIC_RULES) {
      if (pattern.test(path)) {
        if (!topics[topic]) topics[topic] = [];
        topics[topic].push(path);
      }
    }
  }

  return topics;
}

export function isIndexStale(
  currentSha: string,
  storedSha: string | null,
): boolean {
  return currentSha !== storedSha;
}

const MAX_PATHS_PER_TOPIC = 8;

export function buildIndexSummary(topics: TopicMap): string {
  const entries = Object.entries(topics);
  if (entries.length === 0) return "";

  return entries
    .map(([topic, paths]) => {
      const capped = paths.slice(0, MAX_PATHS_PER_TOPIC);
      const overflow = paths.length - capped.length;
      const pathList = capped.join(", ");
      const suffix = overflow > 0 ? ` (+${overflow} more)` : "";
      return `- *${topic}*: ${pathList}${suffix}`;
    })
    .join("\n");
}

// ── KV keys ──────────────────────────────────────────────────────────
const INDEX_SHA_KEY = "index:sha";
const INDEX_TOPICS_KEY = "index:topics";
const INDEX_SUMMARY_KEY = "index:summary";
const INDEX_BUILT_AT_KEY = "index:built_at";

// ── GitHub helpers (import from github.ts at runtime) ────────────────
// These are dynamically imported to keep the pure functions above testable
// without importing Octokit.

interface RepoTreeEntry {
  path: string;
  type: string;
}

async function fetchRepoTree(): Promise<string[]> {
  const { getRepoTree } = await import("@/lib/github");
  const entries: RepoTreeEntry[] = await getRepoTree();
  // Only include blobs (files), not trees (directories)
  return entries.filter((e) => e.type === "blob").map((e) => e.path);
}

async function fetchHeadSha(): Promise<string> {
  const { getHeadSha } = await import("@/lib/github");
  return getHeadSha();
}

// ── Public API ───────────────────────────────────────────────────────

export async function getOrRebuildIndex(): Promise<string> {
  try {
    const currentSha = await fetchHeadSha();
    const storedSha = await kv.get<string>(INDEX_SHA_KEY);

    if (!isIndexStale(currentSha, storedSha)) {
      // Index is fresh — return cached summary
      const summary = await kv.get<string>(INDEX_SUMMARY_KEY);
      return summary ?? "";
    }

    // Rebuild index
    const paths = await fetchRepoTree();
    const topics = classifyTopics(paths);
    const summary = buildIndexSummary(topics);

    // Write to KV (pipeline for atomicity)
    await kv.set(INDEX_SHA_KEY, currentSha);
    await kv.set(INDEX_TOPICS_KEY, JSON.stringify(topics));
    await kv.set(INDEX_SUMMARY_KEY, summary);
    await kv.set(INDEX_BUILT_AT_KEY, new Date().toISOString());

    return summary;
  } catch (err) {
    // If index build fails, return empty — agent falls back to search
    console.error("Repo index build failed:", err);
    return "";
  }
}
