/**
 * Anthropic API error classification — pure functions for extracting
 * structured diagnostics from SDK errors and generating user-facing messages.
 */

export interface ApiErrorInfo {
  /** HTTP status code (0 if not available) */
  status: number;
  /** Anthropic error type (e.g. "rate_limit_error", "model_not_found") */
  type: string;
  /** Raw error message (truncated for logging) */
  message: string;
  /** User-facing error category */
  category: "rate_limit" | "model_error" | "overloaded" | "auth" | "context_too_large" | "unknown";
}

/**
 * Extracts structured error info from an Anthropic SDK error.
 *
 * The SDK throws APIError with `.status`, `.error.type`, and `.message`.
 * This function normalizes the output for logging and classification.
 */
export function classifyApiError(err: unknown): ApiErrorInfo {
  const status = typeof (err as Record<string, unknown>)?.status === "number"
    ? (err as Record<string, number>).status
    : 0;

  // The SDK puts the error type at err.error.type
  const errorBody = (err as Record<string, unknown>)?.error;
  const type = typeof errorBody === "object" && errorBody !== null
    ? String((errorBody as Record<string, unknown>).type ?? "")
    : "";

  const message = err instanceof Error
    ? err.message.slice(0, 300)
    : String(err).slice(0, 300);

  const category = categorize(status, type, message);

  return { status, type, message, category };
}

function categorize(
  status: number,
  type: string,
  message: string,
): ApiErrorInfo["category"] {
  if (status === 429 || type === "rate_limit_error") return "rate_limit";
  if (status === 401 || status === 403 || type === "authentication_error") return "auth";
  if (status === 529 || type === "overloaded_error") return "overloaded";
  if (type === "not_found_error" || message.includes("model")) return "model_error";
  if (message.includes("too long") || message.includes("too many tokens") || message.includes("context length")) return "context_too_large";
  return "unknown";
}

const USER_MESSAGES: Record<ApiErrorInfo["category"], string> = {
  rate_limit: "I'm being rate-limited by the AI provider. Please try again in a minute.",
  model_error: "The AI model configuration has an issue. This needs attention from the maintainer.",
  overloaded: "The AI service is currently overloaded. Please try again shortly.",
  auth: "There's an authentication issue with the AI provider. This needs attention from the maintainer.",
  context_too_large: "This question generated too much context for the AI to process. Try asking about a more specific topic.",
  unknown: "I ran into a technical issue processing this request. Try asking a simpler or more specific question.",
};

/**
 * Returns a user-facing error message based on the error category.
 */
export function userErrorMessage(info: ApiErrorInfo): string {
  return USER_MESSAGES[info.category];
}
