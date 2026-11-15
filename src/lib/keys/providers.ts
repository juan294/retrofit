// Providers a visitor can connect with their own key. Framework-free; no DOM at import time.
// The first five rows are copied unchanged from the vendored runtime's API_KEY_PROVIDERS
// (public/runtime/ui.js:31-75); tests/keys/providers.test.ts compares them with that source.

export type Provider = {
  readonly name: string;
  readonly keyPrefixes: readonly string[];
  /** OpenAI-compatible base URL; the runtime appends /chat/completions and /models. */
  readonly router: string;
  readonly model: string;
  readonly keyUrl: string;
  readonly accessNote: string;
};

export const PROVIDERS: readonly Provider[] = [
  {
    name: "Otari",
    keyUrl: "https://otari.ai/dashboard#/keys",
    router: "https://api.otari.ai/api/v1",
    model: "alibaba/qwen3.8-flash",
    keyPrefixes: ["otk_"],
    accessNote: "Billing may be required",
  },
  {
    name: "Google AI Studio",
    keyUrl: "https://aistudio.google.com/apikey",
    router: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.8-flash",
    keyPrefixes: ["AIza"],
    accessNote: "Free tier",
  },
  {
    name: "Groq",
    keyUrl: "https://console.groq.com/keys",
    router: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    keyPrefixes: ["gsk_"],
    accessNote: "Free tier",
  },
  {
    name: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    router: "https://api.openai.com/v1",
    model: "gpt-5.5",
    keyPrefixes: ["sk-proj-", "sk-svcacct-"],
    accessNote: "Billing may be required",
  },
  {
    name: "Anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    router: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-6",
    keyPrefixes: ["sk-ant-"],
    accessNote: "Billing may be required",
  },
  // Retrofit addition (not in the runtime table).
  {
    name: "OpenRouter",
    keyUrl: "https://openrouter.ai/keys",
    router: "https://openrouter.ai/api/v1",
    // INFERRED: OpenRouter lists `openai/gpt-oss-120b` (seen in its catalog before 2026-06); not
    // re-checked against the live /models list. The manual key check in phase-4.md confirms it.
    model: "openai/gpt-oss-120b",
    keyPrefixes: ["sk-or-v1-"],
    accessNote: "Billing may be required",
  },
];

function routerBase(router: string): string | null {
  try {
    const url = new URL(router);
    if (url.protocol !== "https:" || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

/** The provider whose router equals `router` (one trailing slash ignored), else null. */
export function providerForRouter(router: string): Provider | null {
  const base = routerBase(router);
  if (base === null) return null;
  return PROVIDERS.find((p) => routerBase(p.router) === base) ?? null;
}

/** Each router origin once, in table order (input for connect-src). */
export function routerOrigins(): string[] {
  return [...new Set(PROVIDERS.map((p) => new URL(p.router).origin))];
}
