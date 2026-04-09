import { describe, it, expect } from "vitest";
import { classifyApiError, userErrorMessage } from "./api-error";

describe("classifyApiError", () => {
  it("classifies 429 as rate_limit", () => {
    const err = { status: 429, error: { type: "rate_limit_error" }, message: "Rate limit exceeded" };
    const info = classifyApiError(err);
    expect(info.category).toBe("rate_limit");
    expect(info.status).toBe(429);
    expect(info.type).toBe("rate_limit_error");
  });

  it("classifies 401 as auth", () => {
    const err = { status: 401, error: { type: "authentication_error" }, message: "Invalid API key" };
    const info = classifyApiError(err);
    expect(info.category).toBe("auth");
  });

  it("classifies 403 as auth", () => {
    const err = { status: 403, error: { type: "permission_error" }, message: "Forbidden" };
    const info = classifyApiError(err);
    expect(info.category).toBe("auth");
  });

  it("classifies 529 as overloaded", () => {
    const err = { status: 529, error: { type: "overloaded_error" }, message: "Overloaded" };
    const info = classifyApiError(err);
    expect(info.category).toBe("overloaded");
  });

  it("classifies not_found_error as model_error", () => {
    const err = { status: 404, error: { type: "not_found_error" }, message: "model: claude-sonnet-4-20250514 not found" };
    const info = classifyApiError(err);
    expect(info.category).toBe("model_error");
  });

  it("classifies token overflow messages as context_too_large", () => {
    const err = new Error("prompt is too long: 215432 tokens > 200000 maximum");
    const info = classifyApiError(err);
    expect(info.category).toBe("context_too_large");
  });

  it("classifies message containing 'too many tokens' as context_too_large", () => {
    const err = new Error("Request too large: too many tokens in the request");
    const info = classifyApiError(err);
    expect(info.category).toBe("context_too_large");
  });

  it("classifies unknown errors as unknown", () => {
    const err = new Error("Something unexpected happened");
    const info = classifyApiError(err);
    expect(info.category).toBe("unknown");
    expect(info.status).toBe(0);
  });

  it("handles non-Error values gracefully", () => {
    const info = classifyApiError("string error");
    expect(info.category).toBe("unknown");
    expect(info.message).toBe("string error");
  });

  it("truncates long messages to 300 chars", () => {
    const err = new Error("x".repeat(500));
    const info = classifyApiError(err);
    expect(info.message.length).toBeLessThanOrEqual(300);
  });

  it("extracts error type from nested error.type", () => {
    const err = { status: 400, error: { type: "invalid_request_error", message: "bad request" }, message: "Bad request" };
    const info = classifyApiError(err);
    expect(info.type).toBe("invalid_request_error");
  });

  it("handles missing error.type gracefully", () => {
    const err = { status: 500, message: "Internal server error" };
    const info = classifyApiError(err);
    expect(info.type).toBe("");
  });
});

describe("userErrorMessage", () => {
  it("returns rate limit message for rate_limit category", () => {
    const msg = userErrorMessage({ status: 429, type: "rate_limit_error", message: "", category: "rate_limit" });
    expect(msg).toContain("rate-limited");
  });

  it("returns model error message for model_error category", () => {
    const msg = userErrorMessage({ status: 404, type: "not_found_error", message: "", category: "model_error" });
    expect(msg).toContain("model configuration");
  });

  it("returns overloaded message for overloaded category", () => {
    const msg = userErrorMessage({ status: 529, type: "overloaded_error", message: "", category: "overloaded" });
    expect(msg).toContain("overloaded");
  });

  it("returns auth message for auth category", () => {
    const msg = userErrorMessage({ status: 401, type: "", message: "", category: "auth" });
    expect(msg).toContain("authentication");
  });

  it("returns context message for context_too_large category", () => {
    const msg = userErrorMessage({ status: 0, type: "", message: "", category: "context_too_large" });
    expect(msg).toContain("too much context");
  });

  it("returns generic message for unknown category", () => {
    const msg = userErrorMessage({ status: 0, type: "", message: "", category: "unknown" });
    expect(msg).toContain("technical issue");
  });
});
