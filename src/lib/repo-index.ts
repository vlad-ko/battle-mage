import { kv } from "./kv";
import { log } from "@/lib/logger";
import {
  isVectorConfigured,
  docsNamespace,
  vectorUpsert,
  vectorDeleteNamespace,
} from "./vector";
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

/**
 * Derive a one-line title from a doc path. Originally extracted from the
 * first H1 line of the file (#82/#106), but the content-fetching cost
 * (one GitHub API call per doc × the entire docs tree) caused a 260-call
 * fan-out on large repos and was a direct contributor to the msg_too_long
 * class of errors via system-prompt bloat. See #108.
 *
 * Now: title comes from the path basename, with `-`/`_` → space and
 * word-initial capitals. `docs/features/repo-index.md` → `Repo Index`.
 * Slightly less descriptive than a curated H1 but zero network cost and
 * still meaningful for the agent's doc-discovery decision.
 */
export function extractDocTitle(path: string): string {
  const base = path.split("/").pop() ?? path;
  const stem = base.replace(/\.md$/i, "");
  return stem
    .split(/[-_]/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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
 * Hard cap on doc-catalog entries embedded in the system prompt. Keeps
 * the section bounded regardless of how many docs the target repo has
 * (wealthbot-io/webo has 260; battle-mage has ~10). See #108.
 */
export const MAX_DOC_CATALOG_ENTRIES = 30;

/**
 * Render the doc catalog as a Markdown section for the system prompt.
 * Caps at MAX_DOC_CATALOG_ENTRIES; appends a "(+N more)" note if more
 * exist so the agent knows it can reach them on demand via read_file.
 * Empty string for empty input so the caller can concatenate without
 * worrying about blank sections.
 */
export function buildDocCatalogSection(entries: DocEntry[]): string {
  if (entries.length === 0) return "";
  const capped = entries.slice(0, MAX_DOC_CATALOG_ENTRIES);
  const overflow = entries.length - capped.length;
  const lines = capped
    .map((e) => `- \`${e.path}\` — ${e.title}`)
    .join("\n");
  const overflowNote =
    overflow > 0
      ? `\n\n_(+${overflow} more docs under \`docs/\` — use \`read_file\` with a specific path to load any that aren't listed above.)_`
      : "";
  return (
    `\n## Documentation Index\n\n` +
    `These project docs are available via the \`read_file\` tool — use the title hint to pick which to pull when a question warrants deep context. Don't pull a doc speculatively; only when it's likely to answer the current question.\n\n` +
    `${lines}${overflowNote}\n`
  );
}

// ── Doc chunking for semantic retrieval (#127) ───────────────────────
// Docs are split into heading-scoped chunks and embedded into a
// SHA-scoped vector namespace during index rebuild. Chunking is pure and
// exported for testing; the embedding side effect lives in
// embedDocChunks below.

/**
 * Hard character cap per embedded chunk. Sections larger than this are
 * re-split on paragraph boundaries so no single embedding input is a
 * whole-file blob.
 */
export const MAX_CHUNK_CHARS = 1500;

/**
 * Hard cap on per-rebuild doc content fetches. Same lesson as #108: the
 * embed pipeline reads doc CONTENT (one GitHub call per doc), and on a
 * 260-doc repo an uncapped loop is a fan-out incident. When the cap
 * trips, `docs_embed_capped` is logged so the gap is observable.
 */
export const MAX_DOCS_TO_EMBED = 50;

export interface DocChunk {
  /** Deterministic id: `${path}#${ordinal}`. */
  id: string;
  /** Text sent for embedding: heading + section body. */
  text: string;
  metadata: { path: string; heading: string; excerpt: string };
}

const EXCERPT_MAX_CHARS = 160;

function makeExcerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX_CHARS);
}

// Greedily pack paragraphs into pieces of at most `budget` chars. A
// single paragraph over budget is hard-sliced — pathological, but the
// cap must hold unconditionally.
function splitOnParagraphs(body: string, budget: number): string[] {
  const paragraphs = body.split(/\n{2,}/);
  const pieces: string[] = [];
  let current = "";
  const flush = () => {
    if (current.length > 0) pieces.push(current);
    current = "";
  };
  for (const para of paragraphs) {
    if (para.length > budget) {
      flush();
      for (let i = 0; i < para.length; i += budget) {
        pieces.push(para.slice(i, i + budget));
      }
      continue;
    }
    const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
    if (candidate.length > budget) {
      flush();
      current = para;
    } else {
      current = candidate;
    }
  }
  flush();
  return pieces;
}

/**
 * Split a Markdown doc into heading-scoped chunks for embedding.
 *
 * - Splits on `#`, `##`, and `###` headings; `####`+ stays inside its
 *   parent section (deep subheads are too granular to stand alone).
 * - Content before the first heading becomes a preamble chunk titled
 *   via extractDocTitle(path).
 * - Sections over MAX_CHUNK_CHARS are re-split on paragraph boundaries;
 *   every sub-chunk shares the section heading.
 * - Ids are deterministic `${path}#${ordinal}` so re-embedding the same
 *   content is an idempotent upsert.
 *
 * Pure function — exported for testing.
 */
export function chunkMarkdownByHeadings(path: string, content: string): DocChunk[] {
  if (!content || content.trim().length === 0) return [];

  interface Section {
    heading: string;
    body: string;
  }
  const sections: Section[] = [];
  let currentHeading: string | null = null; // null = preamble
  let buf: string[] = [];
  const flushSection = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (currentHeading === null) {
      // Preamble only becomes a chunk when it has content.
      if (body.length > 0) sections.push({ heading: extractDocTitle(path), body });
    } else {
      sections.push({ heading: currentHeading, body });
    }
  };
  // Fence tracking (#127 review): `# comment` lines inside ``` / ~~~
  // fenced blocks are code, not headings — never split on them.
  let inFence = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    const m = inFence ? null : /^#{1,3} (.+)$/.exec(line);
    if (m) {
      flushSection();
      currentHeading = m[1].trim();
    } else {
      buf.push(line);
    }
  }
  flushSection();

  const chunks: DocChunk[] = [];
  for (const section of sections) {
    // Budget the body so heading + separator + body stays under the cap.
    const budget = Math.max(1, MAX_CHUNK_CHARS - section.heading.length - 2);
    const pieces =
      section.body.length === 0 ? [""] : splitOnParagraphs(section.body, budget);
    for (const piece of pieces) {
      const text = piece.length > 0 ? `${section.heading}\n\n${piece}` : section.heading;
      chunks.push({
        id: `${path}#${chunks.length}`,
        text,
        metadata: {
          path,
          heading: section.heading,
          excerpt: makeExcerpt(piece.length > 0 ? piece : section.heading),
        },
      });
    }
  }
  return chunks;
}

// ── KV keys ──────────────────────────────────────────────────────────
const INDEX_SHA_KEY = "index:sha";
const INDEX_TOPICS_KEY = "index:topics";
const INDEX_SUMMARY_KEY = "index:summary";
const INDEX_DOC_CATALOG_KEY = "index:doc_catalog";
const INDEX_BUILT_AT_KEY = "index:built_at";
// Points at the docs vector namespace currently serving queries (#127).
// Written ONLY after a successful upsert of the new generation, so
// readers never see a half-populated namespace.
const INDEX_VECTOR_DOCS_NS_KEY = "index:vector_docs_ns";

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

    // Build doc catalog from paths alone — no per-file content fetches.
    // See #108 for the fan-out fix.
    const docCatalog = buildDocCatalogFromPaths(paths, config);

    // Write to KV. @upstash/redis auto-stringifies objects on set, so we
    // pass rich values directly; the on-disk JSON bytes are identical
    // to the old manual `JSON.stringify` pattern.
    await kv.set(INDEX_SHA_KEY, currentSha);
    await kv.set(INDEX_TOPICS_KEY, topics);
    await kv.set(INDEX_SUMMARY_KEY, summary);
    await kv.set(INDEX_DOC_CATALOG_KEY, docCatalog);
    await kv.set(INDEX_CONFIG_KEY, config);
    await kv.set(INDEX_BUILT_AT_KEY, new Date().toISOString());

    log("index_rebuilt", {
      sha: currentSha,
      topicCount: Object.keys(topics).length,
      fileCount: paths.length,
      docCount: docCatalog.length,
      duration_ms: Date.now() - startTime,
    });

    // #127: embed doc chunks for hybrid retrieval. Runs ONLY on the
    // SHA-changed path, after every KV write above. Fire-and-forget:
    // embedding (up to MAX_DOCS_TO_EMBED content fetches + an upsert)
    // must NOT sit on the agent's critical path — the rebuild returns
    // the summary immediately and the embed completes in the background
    // within the invocation window. Tradeoff: if the container is
    // killed mid-embed, the docs pointer stays on the previous SHA's
    // namespace until the next SHA change — acceptable, the doc arm
    // just serves slightly stale chunks (or degrades if none exist).
    // embedDocChunks is internally non-throwing; the catch is
    // belt-and-braces so a contract violation can never surface as an
    // unhandled rejection.
    void embedDocChunks(currentSha, filterDocPaths(paths, config)).catch((err) => {
      log("docs_embed_failed", {
        sha: currentSha,
        message: err instanceof Error ? err.message : String(err),
      });
    });

    return summary;
  } catch (err) {
    log("index_build_error", { message: err instanceof Error ? err.message : String(err) });
    return "";
  }
}

/**
 * The docs vector namespace currently serving semantic doc queries, or
 * null when no generation has ever been embedded (or KV is unavailable).
 * Non-throwing — a missing pointer degrades search_repo to lexical-only.
 */
export async function getDocsVectorNamespace(): Promise<string | null> {
  try {
    const ns = await kv.get<string>(INDEX_VECTOR_DOCS_NS_KEY);
    return ns ?? null;
  } catch {
    return null;
  }
}

/**
 * Chunk + embed docs into a fresh SHA-scoped namespace (#127).
 *
 * Generation swap ordering (invariant N1):
 *   1. upsert all chunks into docsNamespace(sha)
 *   2. only on success, repoint INDEX_VECTOR_DOCS_NS_KEY at it
 *   3. best-effort delete the previous generation's namespace
 * An upsert failure leaves the pointer untouched — queries keep serving
 * the previous generation and `docs_embed_failed` records the gap.
 *
 * Non-throwing by construction: any unexpected error is caught and
 * logged so a vector outage can never fail the index rebuild.
 */
async function embedDocChunks(sha: string, docPaths: string[]): Promise<void> {
  // Skip the whole pipeline (including the GitHub content fan-out) when
  // the vector index isn't provisioned — this is the expected state for
  // installs without UPSTASH_VECTOR_REST_*, not an error.
  if (!isVectorConfigured()) return;
  try {
    const startTime = Date.now();
    if (docPaths.length > MAX_DOCS_TO_EMBED) {
      log("docs_embed_capped", {
        totalDocs: docPaths.length,
        cap: MAX_DOCS_TO_EMBED,
      });
    }
    const capped = docPaths.slice(0, MAX_DOCS_TO_EMBED);
    const { readFile } = await import("@/lib/github");
    const chunks: DocChunk[] = [];
    let docCount = 0;
    for (const path of capped) {
      try {
        const result = await readFile(path);
        if ("content" in result && typeof result.content === "string") {
          docCount++;
          chunks.push(...chunkMarkdownByHeadings(path, result.content));
        }
      } catch {
        // Unreadable doc — skip it, embed the rest.
      }
    }

    // Guard (#127 review): an empty chunk set (every readFile failed, or
    // every doc was empty) must NOT swap the pointer — vectorUpsert([])
    // short-circuits true, which would repoint queries at an EMPTY
    // namespace and delete the previous working generation.
    const items = chunks.map((c) => ({ id: c.id, text: c.text, metadata: c.metadata }));
    if (items.length === 0) {
      log("docs_embed_empty", { sha, docCount });
      return;
    }

    const namespace = docsNamespace(sha);
    const ok = await vectorUpsert(namespace, items);
    if (!ok) {
      log("docs_embed_failed", { sha, docCount, chunkCount: chunks.length });
      return;
    }

    const previous = await getDocsVectorNamespace();
    await kv.set(INDEX_VECTOR_DOCS_NS_KEY, namespace);
    if (previous && previous !== namespace) {
      // Best-effort cleanup — vectorDeleteNamespace is non-throwing, and
      // a leaked stale namespace is unreachable once the pointer moved.
      await vectorDeleteNamespace(previous);
    }
    log("docs_embedded", {
      sha,
      docCount,
      chunkCount: chunks.length,
      duration_ms: Date.now() - startTime,
    });
  } catch (err) {
    log("docs_embed_failed", {
      sha,
      message: err instanceof Error ? err.message : String(err),
    });
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
    const parsed = await kv.get<DocEntry[]>(INDEX_DOC_CATALOG_KEY);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Build the doc catalog purely from paths — no content fetching. Previously
// parallel-read every file to grab its H1 title; on a repo with 260 docs
// that was a 260-call GitHub fan-out per index rebuild PLUS a 21 KB prompt
// bloat that contributed to msg_too_long on long turns. See #108.
//
// Sorted alphabetically for deterministic rendering. buildDocCatalogSection
// enforces the hard cap at render time.
function buildDocCatalogFromPaths(
  paths: string[],
  config: BattleMageConfig,
): DocEntry[] {
  const docPaths = filterDocPaths(paths, config);
  return docPaths
    .map((path): DocEntry => ({ path, title: extractDocTitle(path) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Get the cached config from KV (loaded during last index build).
 * Returns empty config if not yet built.
 */
export async function getCachedTopics(): Promise<TopicMap> {
  try {
    const topics = await kv.get<TopicMap>(INDEX_TOPICS_KEY);
    return topics ?? {};
  } catch {
    return {};
  }
}

export async function getCachedConfig(): Promise<BattleMageConfig> {
  try {
    const config = await kv.get<BattleMageConfig>(INDEX_CONFIG_KEY);
    if (config) return config;
    return { paths: {} };
  } catch {
    return { paths: {} };
  }
}
