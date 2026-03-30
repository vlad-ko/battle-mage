/**
 * Progress Message Formatter — maps tool calls to user-friendly status messages.
 * All messages use italic text (Slack _underscores_) to visually distinguish
 * from the actual answer.
 */

const MAX_PATH_LENGTH = 60;

function truncatePath(path: string): string {
  if (path.length <= MAX_PATH_LENGTH) return path;
  // Keep the last N characters with "..." prefix
  return "..." + path.slice(-(MAX_PATH_LENGTH - 3));
}

type ToolInput = Record<string, unknown>;

const TOOL_FORMATS: Record<string, (input: ToolInput) => string> = {
  thinking: () => "🧠 _Thinking about your question..._",
  index: () => "🗂️ _Checking repo index..._",
  search_code: (input) => {
    const query = (input.query as string) || "code";
    return `🔍 _Searching for "${query}"..._`;
  },
  read_file: (input) => {
    const path = truncatePath((input.path as string) || "file");
    return `👓 _Reading ${path}..._`;
  },
  list_issues: () => "🎫 _Looking up issues..._",
  create_issue: () => "📝 _Drafting issue proposal..._",
  save_knowledge: () => "💾 _Saving to knowledge base..._",
  composing: () => "✏️ _Composing answer..._",
};

export function formatProgressMessage(
  toolName: string,
  input: ToolInput,
): string {
  const formatter = TOOL_FORMATS[toolName];
  if (formatter) return formatter(input);
  // Fallback for unknown tools
  return `🧠 _Working on it..._`;
}
