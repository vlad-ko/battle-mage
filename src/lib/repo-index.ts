import { kv } from "@vercel/kv";
import { log } from "@/lib/logger";
import {
  type BattleMageConfig,
  parseBattleMageConfig,
  getAnnotation,
  filterPathsByAnnotation,
} from "./config";

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
  ["security", /security|firewall|waf|ip.?block|rate.?limit|encrypt|cipher|tls|ssl|audit|compliance|soc2|gitguardian|ggshield|checkov|bridgecrew|snyk|trivy|grype|codeql|semgrep|scc|vulnerability|pentest/i],
  ["configuration", /config\/|\.env|docker-compose|\.ya?ml$|\.json$/i],
];

// Fallback for repos without .battle-mage.json
const DEFAULT_EXCLUDED_PREFIXES = ["vendor/", "node_modules/", ".git/", ".claude/", "dist/", "build/"];

// ── Pure functions (exported for testing) ─────────────────────────────

export type TopicMap = Record<string, string[]>;

export function classifyTopics(
  paths: string[],
  config?: BattleMageConfig,
): TopicMap {
  const topics: TopicMap = {};

  // Filter out excluded paths using config or fallback
  const filteredPaths = config
    ? filterPathsByAnnotation(paths, config, ["excluded"])
    : paths.filter((p) => !DEFAULT_EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix)));

  for (const path of filteredPaths) {
    const annotation = config ? getAnnotation(path, config) : "current";

    // Route historic and vendor paths to pseudo-topics
    if (annotation === "historic") {
      if (!topics["_historic"]) topics["_historic"] = [];
      topics["_historic"].push(path);
      continue;
    }
    if (annotation === "vendor") {
      if (!topics["_vendor"]) topics["_vendor"] = [];
      topics["_vendor"].push(path);
      continue;
    }

    // Normal topic classification
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

const PSEUDO_TOPIC_HINTS: Record<string, string> = {
  _historic: "(use only for history questions)",
  _vendor: "(use only for dependency questions)",
};

export function buildIndexSummary(topics: TopicMap): string {
  const entries = Object.entries(topics);
  if (entries.length === 0) return "";

  // Sort: regular topics first, then pseudo-topics (_historic, _vendor) last
  entries.sort((a, b) => {
    const aIsPseudo = a[0].startsWith("_") ? 1 : 0;
    const bIsPseudo = b[0].startsWith("_") ? 1 : 0;
    return aIsPseudo - bIsPseudo;
  });

  return entries
    .map(([topic, paths]) => {
      const capped = paths.slice(0, MAX_PATHS_PER_TOPIC);
      const overflow = paths.length - capped.length;
      const pathList = capped.join(", ");
      const suffix = overflow > 0 ? ` (+${overflow} more)` : "";
      const hint = PSEUDO_TOPIC_HINTS[topic] || "";
      const label = topic.startsWith("_") ? topic.slice(1) : topic;
      return `- *${label}*${hint ? " " + hint : ""}: ${pathList}${suffix}`;
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

// ── Config loading ───────────────────────────────────────────────────
const INDEX_CONFIG_KEY = "index:config";

async function fetchBattleMageConfig(): Promise<BattleMageConfig> {
  try {
    const { readFile } = await import("@/lib/github");
    const result = await readFile(".battle-mage.json");
    if ("content" in result && typeof result.content === "string") {
      return parseBattleMageConfig(result.content);
    }
    return { paths: {} };
  } catch {
    return { paths: {} };
  }
}

// ── Public API ───────────────────────────────────────────────────────

export async function getOrRebuildIndex(): Promise<string> {
  try {
    const currentSha = await fetchHeadSha();
    const storedSha = await kv.get<string>(INDEX_SHA_KEY);

    if (!isIndexStale(currentSha, storedSha)) {
      log("index_cache_hit", { sha: currentSha });
      const summary = await kv.get<string>(INDEX_SUMMARY_KEY);
      return summary ?? "";
    }

    // Load config and rebuild index
    const startTime = Date.now();
    const config = await fetchBattleMageConfig();
    log("config_loaded", { hasConfig: Object.keys(config.paths).length > 0, pathCount: Object.keys(config.paths).length });
    const paths = await fetchRepoTree();
    const topics = classifyTopics(paths, config);
    const summary = buildIndexSummary(topics);

    // Write to KV
    await kv.set(INDEX_SHA_KEY, currentSha);
    await kv.set(INDEX_TOPICS_KEY, JSON.stringify(topics));
    await kv.set(INDEX_SUMMARY_KEY, summary);
    await kv.set(INDEX_CONFIG_KEY, JSON.stringify(config));
    await kv.set(INDEX_BUILT_AT_KEY, new Date().toISOString());

    log("index_rebuilt", { sha: currentSha, topicCount: Object.keys(topics).length, fileCount: paths.length, duration_ms: Date.now() - startTime });
    return summary;
  } catch (err) {
    log("index_build_error", { message: err instanceof Error ? err.message : String(err) });
    return "";
  }
}

/**
 * Get the cached config from KV (loaded during last index build).
 * Returns empty config if not yet built.
 */
export async function getCachedTopics(): Promise<TopicMap> {
  try {
    const raw = await kv.get<string>(INDEX_TOPICS_KEY);
    if (raw) {
      return typeof raw === "string" ? JSON.parse(raw) : (raw as TopicMap);
    }
    return {};
  } catch {
    return {};
  }
}

export async function getCachedConfig(): Promise<BattleMageConfig> {
  try {
    const raw = await kv.get<string>(INDEX_CONFIG_KEY);
    if (raw) {
      return typeof raw === "string" ? JSON.parse(raw) : (raw as BattleMageConfig);
    }
    return { paths: {} };
  } catch {
    return { paths: {} };
  }
}
