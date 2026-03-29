import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { searchCode } from "@/lib/github";

export const searchCodeTool: Tool = {
  name: "search_code",
  description:
    "Search for code across the repository. Returns matching file paths with relevance scores. Use this to find where specific functions, classes, patterns, or keywords exist in the codebase.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "Search query — can be a function name, class name, keyword, or code pattern",
      },
    },
    required: ["query"],
  },
};

export async function executeSearchCode(
  input: Record<string, unknown>,
): Promise<string> {
  const query = input.query as string;
  const results = await searchCode(query);

  if (results.length === 0) {
    return `No results found for "${query}".`;
  }

  return results
    .map((r) => `- \`${r.path}\` (score: ${r.score}) — ${r.url}`)
    .join("\n");
}
