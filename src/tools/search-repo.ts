import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { searchCode } from "@/lib/github";
import { vectorQuery, srcNamespace, type VectorMatch } from "@/lib/vector";
import { getDocsVectorNamespace } from "@/lib/repo-index";
import {
  fuseRankedLists,
  mergeSemanticMatches,
  MAX_ARM_RESULTS,
} from "@/lib/retrieval";
import { isToolingPath } from "@/lib/path-filter";
import type { Reference } from "@/tools";

/**
 * Hybrid repo search (#127, #135): fuses a lexical GitHub code-search
 * arm with a semantic arm (Upstash Vector) via Reciprocal Rank Fusion.
 * The semantic arm itself is a score-merge of doc chunks (SHA-scoped
 * namespace behind the repo-index pointer) and embedded source chunks
 * (stable src namespace, #135) — same embedding model, so their raw
 * scores are comparable and mergeSemanticMatches sorts them directly.
 * Arms carry typed ids (`code:${path}` / `doc:${chunkId}` /
 * `src:${chunkId}`) so results render as typed lines the model can
 * tell apart — the same path can legitimately appear as both a [code]
 * and a [src] line.
 *
 * Degradation: a missing docs-namespace pointer (index never embedded)
 * or a degraded vector layer (vectorQuery → null) silently collapses
 * that semantic sub-arm; both degraded collapses to lexical-only — the
 * tool never throws because of the semantic arm.
 */
export const searchRepoTool: Tool = {
  name: "search_repo",
  description:
    "Hybrid search across BOTH code and documentation — combines lexical code search with semantic (meaning-based) doc search. Best for conceptual questions like \"how does X work\" or \"where is Y handled\" where you don't know the exact identifier. For an exact function/class/keyword, use search_code instead.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "Natural-language or keyword query — a concept, feature, or question phrase",
      },
    },
    required: ["query"],
  },
};

export interface SearchRepoResult {
  text: string;
  references: Reference[];
}

interface CodeItem {
  path: string;
  url: string;
  score: number;
}

async function runCodeArm(query: string): Promise<CodeItem[]> {
  const results = await searchCode(query);
  // Filter out tooling paths (.claude/ etc.) — not project code.
  return results.filter((r) => !isToolingPath(r.path)).slice(0, MAX_ARM_RESULTS);
}

async function runDocArm(query: string): Promise<VectorMatch[]> {
  const namespace = await getDocsVectorNamespace();
  if (!namespace) return []; // index never embedded docs — docs sub-arm off
  const matches = await vectorQuery(namespace, query, MAX_ARM_RESULTS);
  return matches ?? []; // null = vector degraded — docs sub-arm off
}

async function runSrcArm(query: string): Promise<VectorMatch[]> {
  // The src namespace is STABLE (no pointer, no SHA scope — see #135):
  // an empty or missing namespace simply returns no matches.
  const matches = await vectorQuery(srcNamespace(), query, MAX_ARM_RESULTS);
  return matches ?? []; // null = vector degraded — src sub-arm off
}

export async function executeSearchRepo(
  input: Record<string, unknown>,
): Promise<SearchRepoResult> {
  // Guard (#127 review): the model can emit a malformed tool call —
  // a missing/non-string/blank query must not reach searchCode.
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (query.length === 0) {
    return { text: "No search query provided.", references: [] };
  }

  const [codeItems, docMatches, srcMatches] = await Promise.all([
    runCodeArm(query),
    runDocArm(query),
    runSrcArm(query),
  ]);

  // Semantic sub-arms share one embedding model → raw scores merge
  // directly (docs win exact ties — stable). Typed ids (`doc:`/`src:`)
  // keep them apart from each other AND from the lexical `code:` ids.
  const semantic = mergeSemanticMatches(
    docMatches.map((m) => ({ ...m, id: `doc:${m.id}` })),
    srcMatches.map((m) => ({ ...m, id: `src:${m.id}` })),
    MAX_ARM_RESULTS,
  );

  // Cross-arm fusion stays a rank interleave (RRF) with lexical winning
  // exact ties. No timestamps — repo content freshness is a per-SHA
  // property, not a per-result one.
  const lexicalIds = codeItems.map((i) => `code:${i.path}`);
  const semanticIds = semantic.map((m) => m.id);
  const fused = fuseRankedLists(lexicalIds, semanticIds, { topK: MAX_ARM_RESULTS });

  if (fused.length === 0) {
    return { text: `No results found for "${query}".`, references: [] };
  }

  const codeById = new Map(codeItems.map((i) => [`code:${i.path}`, i]));
  const semanticById = new Map(semantic.map((m) => [m.id, m]));

  const lines = fused.map((f) => {
    const code = codeById.get(f.id);
    if (code) {
      return `- [code] \`${code.path}\` (score: ${code.score}) — ${code.url}`;
    }
    const match = semanticById.get(f.id)!;
    if (f.id.startsWith("src:")) {
      const meta = (match.metadata ?? {}) as {
        path?: string;
        startLine?: number;
        endLine?: number;
        excerpt?: string;
      };
      const path = meta.path ?? f.id.slice("src:".length).split("#")[0];
      const range =
        meta.startLine !== undefined && meta.endLine !== undefined
          ? `:L${meta.startLine}-${meta.endLine}`
          : "";
      const excerpt = meta.excerpt ? ` — ${meta.excerpt}` : "";
      return `- [src] \`${path}${range}\`${excerpt}`;
    }
    const meta = (match.metadata ?? {}) as {
      path?: string;
      heading?: string;
      excerpt?: string;
    };
    const path = meta.path ?? f.id.slice("doc:".length).split("#")[0];
    const heading = meta.heading ? ` › ${meta.heading}` : "";
    const excerpt = meta.excerpt ? ` — ${meta.excerpt}` : "";
    return `- [doc] \`${path}\`${heading}${excerpt}`;
  });

  // Search results are discovery aids — don't add them as references.
  // Only files the agent actually reads (via read_file) get referenced.
  return { text: lines.join("\n"), references: [] };
}
