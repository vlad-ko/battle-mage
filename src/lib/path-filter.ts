/**
 * Path filtering — identifies tooling/metadata paths that should be
 * excluded from search results, file reads, and topic indexing.
 *
 * The .claude/ directory contains Claude Code configuration and skills —
 * these are AI tooling files, not project source code.
 */

const TOOLING_PREFIXES = [".claude/"];

/**
 * Returns true if the path belongs to a tooling/metadata directory
 * that should not be treated as project code.
 */
export function isToolingPath(path: string): boolean {
  return TOOLING_PREFIXES.some((prefix) => path.startsWith(prefix));
}
