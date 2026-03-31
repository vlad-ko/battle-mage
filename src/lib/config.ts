/**
 * Battle Mage Configuration — .battle-mage.json loader
 *
 * Path annotations give the agent graduated trust levels:
 * - core: primary source code, highest trust
 * - current: up-to-date content, normal trust (default)
 * - historic: archived/outdated, low trust
 * - vendor: third-party code, low trust
 * - excluded: invisible to the agent
 */

export type PathAnnotation = "core" | "current" | "historic" | "vendor" | "excluded";

const VALID_ANNOTATIONS = new Set<PathAnnotation>(["core", "current", "historic", "vendor", "excluded"]);

export interface BattleMageConfig {
  paths: Record<string, PathAnnotation>;
}

// ── Parse config from raw JSON string ────────────────────────────────

export function parseBattleMageConfig(raw: string | null): BattleMageConfig {
  if (!raw) return { paths: {} };

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.paths !== "object") {
      return { paths: {} };
    }

    // Filter to only valid annotation values
    const paths: Record<string, PathAnnotation> = {};
    for (const [key, value] of Object.entries(parsed.paths)) {
      if (VALID_ANNOTATIONS.has(value as PathAnnotation)) {
        paths[key] = value as PathAnnotation;
      }
    }

    return { paths };
  } catch {
    return { paths: {} };
  }
}

// ── Get annotation for a file path (longest prefix match) ────────────

export function getAnnotation(
  filePath: string,
  config: BattleMageConfig,
): PathAnnotation {
  const prefixes = Object.keys(config.paths);
  if (prefixes.length === 0) return "current";

  // Sort by length descending — longest match wins
  let bestMatch: PathAnnotation = "current";
  let bestLength = 0;

  for (const prefix of prefixes) {
    if (filePath.startsWith(prefix) && prefix.length > bestLength) {
      bestMatch = config.paths[prefix];
      bestLength = prefix.length;
    }
  }

  return bestMatch;
}

// ── Filter paths by excluding certain annotations ────────────────────

export function filterPathsByAnnotation(
  paths: string[],
  config: BattleMageConfig,
  excludeAnnotations: PathAnnotation[],
): string[] {
  if (excludeAnnotations.length === 0) return paths;
  const excludeSet = new Set(excludeAnnotations);
  return paths.filter((p) => !excludeSet.has(getAnnotation(p, config)));
}
