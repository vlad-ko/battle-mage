import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { readFile } from "@/lib/github";

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read the contents of a file from the repository. Returns the full file content. For directories, returns a listing of entries. Use this to verify code exists and understand implementation details before answering questions.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "File path relative to repo root, e.g. 'src/app.ts'",
      },
      ref: {
        type: "string",
        description:
          "Optional git ref (branch, tag, or SHA). Defaults to the default branch.",
      },
    },
    required: ["path"],
  },
};

export async function executeReadFile(
  input: Record<string, unknown>,
): Promise<string> {
  const path = input.path as string;
  const ref = input.ref as string | undefined;

  const result = await readFile(path, ref);

  if ("content" in result && typeof result.content === "string") {
    return `**${result.path}** (${result.size} bytes)\n\`\`\`\n${result.content}\n\`\`\``;
  }

  if ("entries" in result) {
    const entries = result.entries as Array<{
      name: string;
      type: string;
      path: string;
    }>;
    return (
      `**${result.path}/** (directory)\n` +
      entries.map((e) => `- ${e.type === "dir" ? "📁" : "📄"} ${e.name}`).join("\n")
    );
  }

  return "Unexpected response format.";
}
