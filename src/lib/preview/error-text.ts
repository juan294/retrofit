// The runtime shows a router error as "<warning sign emoji> LLM HTTP <status>: <first 300 characters of the body>"
// (public/runtime/llm.js, vendored). For an OpenAI-style JSON error, the visitor should read its message.

const RUNTIME_ERROR = /^\u26A0\uFE0F? LLM HTTP \d{3}: (\{[\s\S]*\})$/u;

/** The JSON error's message for the bubble, or null when the text should stay as it is. The caller adds the warning icon. */
export function friendlyRuntimeError(text: string): string | null {
  const match = RUNTIME_ERROR.exec(text.trim());
  if (!match) return null;
  try {
    const body = JSON.parse(match[1]!) as { error?: { message?: unknown } };
    const message = body.error?.message;
    return typeof message === "string" && message.trim() ? message.trim() : null;
  } catch {
    return null;
  }
}
