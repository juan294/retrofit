// The runtime shows a router error as "⚠️ LLM HTTP <status>: <first 300 characters of the body>"
// (public/runtime/llm.js, vendored). For an OpenAI-style JSON error, the visitor should read its message.

const RUNTIME_ERROR = /^⚠️ LLM HTTP \d{3}: (\{[\s\S]*\})$/;

/** The bubble text with the JSON error's message, or null when the text should stay as it is. */
export function friendlyRuntimeError(text: string): string | null {
  const match = RUNTIME_ERROR.exec(text.trim());
  if (!match) return null;
  try {
    const body = JSON.parse(match[1]!) as { error?: { message?: unknown } };
    const message = body.error?.message;
    return typeof message === "string" && message.trim() ? `⚠️ ${message.trim()}` : null;
  } catch {
    return null;
  }
}
