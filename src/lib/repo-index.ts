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

// ── Documentation catalog (see #82) ──────────────────────────────────
// Surfaces every `docs/**/*.md` to the model as a catalog with one-line
// descriptions, so the agent can decide which doc to pull via `read_file`
// without stuffing every doc body into the prompt. Cached alongside the
// topic map, invalidated on HEAD SHA change.

export interface DocEntry {
  path: string;
  title: string;
}

const H1_LINE_RE = /^#\s+(.+?)\s*$/m;

/**
 * Extract a one-line title from a Markdown doc. Takes the first H1 line
 * (`# Title`) as the title; falls back to the path basename without
 * extension when no H1 is found (or content is empty). The H1 heuristic
 * is intentionally simple (no AST parsing): first line matching `^# ` in
 * the document. Code fences start with ` ``` ` not `# `, so they don't
 * trip the regex naturally.
 */
export function extractDocTitle(content: string, path: string): string {
  const match = content.match(H1_LINE_RE);
  if (match && match[1].trim().length > 0) {
    return match[1].trim();
  }
  // Fallback: basename without .md/.MD extension.
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

const DOC_PATH_RE = /^docs\/.+\.md$/i;

/**
 * Keep only Markdown files under the `docs/` tree, honoring the
 * battle-mage config's `excluded` and `historic` annotations so
 * internal/archive docs don't bloat the catalog.
 */
export function filterDocPaths(
  paths: string[],
  config?: BattleMageConfig,
): string[] {
  return paths.filter((p) => {
    if (!DOC_PATH_RE.test(p)) return false;
    if (!config) return true;
    const annotation = getAnnotation(p, config);
    return annotation !== "excluded" && annotation !== "historic";
  });
}

/**
 * Render the doc catalog as a Markdown section for the system prompt.
 * Empty string for empty input so the caller can concatenate without
 * worrying about blank sections.
 */
export function buildDocCatalogSection(entries: DocEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries
    .map((e) => `- \`${e.path}\` — ${e.title}`)
    .join("\n");
  return (
    `\n## Documentation Index\n\n` +
    `These project docs are available via the \`read_file\` tool — use the title hint to pick which to pull when a question warrants deep context. Don't pull a doc speculatively; only when it's likely to answer the current question.\n\n` +
    `${lines}\n`
  );
}

// ── KV keys ──────────────────────────────────────────────────────────
const INDEX_SHA_KEY = "index:sha";
const INDEX_TOPICS_KEY = "index:topics";
const INDEX_SUMMARY_KEY = "index:summary";
const INDEX_DOC_CATALOG_KEY = "index:doc_catalog";
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

    // Build doc catalog in parallel with the rest — fetches content for
    // every docs/**/*.md to extract H1 titles. Cold-path only; cached on
    // same SHA-keyed invalidation as the topic map. See #82.
    const docCatalog = await fetchDocCatalog(paths, config);

    // Write to KV
    await kv.set(INDEX_SHA_KEY, currentSha);
    await kv.set(INDEX_TOPICS_KEY, JSON.stringify(topics));
    await kv.set(INDEX_SUMMARY_KEY, summary);
    await kv.set(INDEX_DOC_CATALOG_KEY, JSON.stringify(docCatalog));
    await kv.set(INDEX_CONFIG_KEY, JSON.stringify(config));
    await kv.set(INDEX_BUILT_AT_KEY, new Date().toISOString());

    log("index_rebuilt", {
      sha: currentSha,
      topicCount: Object.keys(topics).length,
      fileCount: paths.length,
      docCount: docCatalog.length,
      duration_ms: Date.now() - startTime,
    });
    return summary;
  } catch (err) {
    log("index_build_error", { message: err instanceof Error ? err.message : String(err) });
    return "";
  }
}

/**
 * Fetch the cached doc catalog (built alongside the topic index). Returns
 * an empty array if the index has never been built or the key is missing.
 * Non-throwing — treats KV errors as "no catalog yet", keeping the agent
 * loop resilient to storage flakes. See #82.
 */
export async function getDocCatalog(): Promise<DocEntry[]> {
  try {
    const raw = await kv.get<string>(INDEX_DOC_CATALOG_KEY);
    if (!raw) return [];
    const parsed = typeof raw === "string" ? JSON.parse(raw) : (raw as DocEntry[]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Parallel fetch + H1 extraction for every doc path. Individual file
// failures degrade gracefully to the basename fallback — one broken doc
// shouldn't deprive the agent of the rest of the catalog.
async function fetchDocCatalog(
  paths: string[],
  config: BattleMageConfig,
): Promise<DocEntry[]> {
  const docPaths = filterDocPaths(paths, config);
  if (docPaths.length === 0) return [];

  const { readFile } = await import("@/lib/github");
  const entries = await Promise.all(
    docPaths.map(async (path): Promise<DocEntry> => {
      try {
        const result = await readFile(path);
        const content =
          "content" in result && typeof result.content === "string"
            ? result.content
            : "";
        return { path, title: extractDocTitle(content, path) };
      } catch {
        // Per-file failure: fall back to basename-as-title. The catalog
        // still surfaces the path so the agent can try read_file later.
        return { path, title: extractDocTitle("", path) };
      }
    }),
  );
  return entries;
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
