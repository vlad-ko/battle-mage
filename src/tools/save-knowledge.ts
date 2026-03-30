import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { appendKnowledge } from "@/lib/github";

export const saveKnowledgeTool: Tool = {
  name: "save_knowledge",
  description:
    "Save a correction or learned fact to the persistent knowledge base (.battle-mage/knowledge.md in the target repo). Use this when a user corrects you, provides insider knowledge about the codebase, or clarifies something that would be wrong in future conversations. The entry is committed directly — no confirmation needed.",
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
  const path = await appendKnowledge(entry);
  return `Saved to knowledge base (${path}): "${entry}"`;
}
