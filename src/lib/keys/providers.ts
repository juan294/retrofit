// Providers a visitor can connect with their own key. Framework-free; no DOM at import time.
// The rows are copied unchanged, in order, from the vendored runtime's API_KEY_PROVIDERS
// (public/runtime/ui.js:33-99, agentic-web 0516537); tests/keys/providers.test.ts compares them
// with that source. The runtime now ships the OpenRouter row that Retrofit used to add itself.

export type Provider = {
  readonly name: string;
  readonly keyPrefixes: readonly string[];
  /** OpenAI-compatible base URL; the runtime appends /chat/completions and /models. */
  readonly router: string;
  readonly model: string;
  readonly keyUrl: string;
  readonly accessNote: string;
  /** false: detected from the key, but no provider button (the runtime's "Otari EU" row). */
  readonly button?: false;
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
  // An otari.ai key belongs to one region; the other gateway answers HTTP 421. EU keys start
  // with "otk_v1_eu_"; the longest prefix wins in detectProvider.
  {
    name: "Otari EU",
    keyUrl: "https://otari.ai/dashboard#/keys",
    router: "https://eu.api.otari.ai/api/v1",
    model: "alibaba/qwen3.8-flash",
    keyPrefixes: ["otk_v1_eu_"],
    accessNote: "Billing may be required",
    button: false,
  },
  {
    name: "Google AI Studio",
    keyUrl: "https://aistudio.google.com/apikey",
    router: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "models/gemini-3.8-flash",
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
    name: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    router: "https://openrouter.ai/api/v1",
    model: "google/gemma-4-31b-it:free",
    keyPrefixes: ["sk-or-"],
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
];

/** The providers that get a button in the key panel (the runtime's provider buttons). */
export const BUTTON_PROVIDERS: readonly Provider[] = PROVIDERS.filter((p) => p.button !== false);

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
