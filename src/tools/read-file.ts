import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { readFile } from "@/lib/github";
import type { Reference } from "@/tools";
import { isToolingPath } from "@/lib/path-filter";

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

export interface ReadFileResult {
  text: string;
  references: Reference[];
}

export async function executeReadFile(
  input: Record<string, unknown>,
): Promise<ReadFileResult> {
  const path = input.path as string;
  const ref = input.ref as string | undefined;

  // Block reads of tooling paths (.claude/ etc.) — not project code
  if (isToolingPath(path)) {
    return { text: `Path "${path}" is a tooling/metadata directory and cannot be read.`, references: [] };
  }

  const result = await readFile(path, ref);

  if ("content" in result && typeof result.content === "string") {
    // Use the actual GitHub html_url (direct link to the file on GitHub)
    const refs: Reference[] = result.url
      ? [{ label: result.path, url: result.url, type: result.path.endsWith(".md") || result.path.startsWith("docs/") ? "doc" as const : "file" as const }]
      : [];
    return {
      text: `**${result.path}** (${result.size} bytes)\n\`\`\`\n${result.content}\n\`\`\``,
      references: refs,
    };
  }

  if ("entries" in result) {
    const entries = result.entries as Array<{
      name: string;
      type: string;
      path: string;
    }>;
    return {
      text:
        `**${result.path}/** (directory)\n` +
        entries
          .map((e) => `- ${e.type === "dir" ? "📁" : "📄"} ${e.name}`)
          .join("\n"),
      references: [],
    };
  }

  return { text: "Unexpected response format.", references: [] };
}
