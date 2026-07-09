import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { searchCode } from "@/lib/github";
import { vectorQuery, type VectorMatch } from "@/lib/vector";
import { getDocsVectorNamespace } from "@/lib/repo-index";
import { fuseRankedLists, MAX_ARM_RESULTS } from "@/lib/retrieval";
import { isToolingPath } from "@/lib/path-filter";
import type { Reference } from "@/tools";

/**
 * Hybrid repo search (#127): fuses a lexical GitHub code-search arm with
 * a semantic doc-chunk arm (Upstash Vector) via Reciprocal Rank Fusion.
 * Arms carry typed ids (`code:${path}` / `doc:${chunkId}`) so results
 * render as typed lines the model can tell apart.
 *
 * Degradation: a missing docs-namespace pointer (index never embedded)
 * or a degraded vector layer (vectorQuery → null) silently collapses to
 * lexical-only — the tool never throws because of the semantic arm.
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
  if (!namespace) return []; // index never embedded docs — lexical-only
  const matches = await vectorQuery(namespace, query, MAX_ARM_RESULTS);
  return matches ?? []; // null = vector degraded — lexical-only
}

export async function executeSearchRepo(
  input: Record<string, unknown>,
): Promise<SearchRepoResult> {
  const query = input.query as string;

  const [codeItems, docMatches] = await Promise.all([
    runCodeArm(query),
    runDocArm(query),
  ]);

  // Typed ids keep the arms disjoint; fusion is a rank interleave with
  // lexical winning exact ties. No timestamps — repo content freshness
  // is a per-SHA property, not a per-result one.
  const lexicalIds = codeItems.map((i) => `code:${i.path}`);
  const semanticIds = docMatches.map((m) => `doc:${m.id}`);
  const fused = fuseRankedLists(lexicalIds, semanticIds, { topK: MAX_ARM_RESULTS });

  if (fused.length === 0) {
    return { text: `No results found for "${query}".`, references: [] };
  }

  const codeById = new Map(codeItems.map((i) => [`code:${i.path}`, i]));
  const docById = new Map(docMatches.map((m) => [`doc:${m.id}`, m]));

  const lines = fused.map((f) => {
    const code = codeById.get(f.id);
    if (code) {
      return `- [code] \`${code.path}\` (score: ${code.score}) — ${code.url}`;
    }
    const doc = docById.get(f.id)!;
    const meta = (doc.metadata ?? {}) as {
      path?: string;
      heading?: string;
      excerpt?: string;
    };
    const path = meta.path ?? String(doc.id).split("#")[0];
    const heading = meta.heading ? ` › ${meta.heading}` : "";
    const excerpt = meta.excerpt ? ` — ${meta.excerpt}` : "";
    return `- [doc] \`${path}\`${heading}${excerpt}`;
  });

  // Search results are discovery aids — don't add them as references.
  // Only files the agent actually reads (via read_file) get referenced.
  return { text: lines.join("\n"), references: [] };
}
