import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { saveKnowledgeEntry } from "@/lib/knowledge";

export const saveKnowledgeTool: Tool = {
  name: "save_knowledge",
  description:
    "Save a correction or learned fact to the persistent knowledge base (Vercel KV). Use this when a user corrects you, provides insider knowledge about the codebase, or clarifies something that would be wrong in future conversations. The entry is saved immediately — no confirmation needed. Does NOT write to the GitHub repo.",
  input_schema: {
    type: "object" as const,
    properties: {
      entry: {
        type: "string",
        description:
          "A concise factual statement to remember. Write it as a standalone fact, not a conversation snippet. E.g. 'The auth module lives in app/Services/Auth, not app/Http/Auth' or 'The Tradier API rate limit is 120 req/min, not 60'.",
      },
    },
    required: ["entry"],
  },
};

export async function executeSaveKnowledge(
  input: Record<string, unknown>,
): Promise<string> {
  const entry = input.entry as string;
  await saveKnowledgeEntry(entry);
  return `Saved to knowledge base: "${entry}"`;
}
