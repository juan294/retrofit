// Validates a visitor key straight against the provider, from the browser. The key goes only in
// the Authorization header to the provider's router: never in a URL, a message or a log, and
// never to Retrofit's origin. Messages never echo the key or the provider's response body.

import { providerForRouter, type Provider } from "./providers";

export type KeyTestFailureKind = "unauthorized" | "cors" | "model-missing" | "network" | "http";

export type PricePerMillion = { input: number; output: number };

export type KeyTestResult =
  | { ok: true; models?: string[]; pricePerMillion?: PricePerMillion; checkedOnFirstMessage?: true }
  | { ok: false; kind: KeyTestFailureKind; message: string };

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type KeyTestInput = {
  /** The provider row; or give `router` and the row is found from it. */
  provider?: Provider;
  /** One of the routers in providers.ts (Advanced). Defaults to the provider's router. */
  router?: string;
  key: string;
  /** Defaults to the provider's model. */
  model?: string;
  /** Defaults to globalThis.fetch (the installed fetch guard in the browser). */
  fetch?: FetchFn;
  timeoutMs?: number;
};

const ANTHROPIC_HOST = "api.anthropic.com";
// Keys are printable ASCII without spaces; anything else would make Headers throw a TypeError.
const KEY_SHAPE = /^[\x21-\x7e]+$/;

const fail = (kind: KeyTestFailureKind, message: string): KeyTestResult => ({ ok: false, kind, message });

function modelIds(body: unknown): Array<{ id: string; pricing?: unknown }> | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  return data.filter(
    (entry): entry is { id: string; pricing?: unknown } =>
      typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string",
  );
}

// INFERRED: Google's OpenAI-compatible /models returns ids as "models/<id>"; chat takes "<id>".
const bareId = (id: string) => id.replace(/^models\//, "");

function perMillion(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n * 1e6 : null;
}

/** OpenRouter reports `pricing.prompt` and `pricing.completion` in dollars per token. */
function priceOf(entry: { pricing?: unknown } | undefined): PricePerMillion | undefined {
  const pricing = entry?.pricing as { prompt?: unknown; completion?: unknown } | undefined;
  if (!pricing || typeof pricing !== "object") return undefined;
  const input = perMillion(pricing.prompt);
  const output = perMillion(pricing.completion);
  return input === null || output === null ? undefined : { input, output };
}

export async function testKey(input: KeyTestInput): Promise<KeyTestResult> {
  const provider = input.provider ?? (input.router ? providerForRouter(input.router) : null);
  const router = input.router ?? provider?.router;
  if (!provider || !router || providerForRouter(router) === null) {
    return fail("http", "Retrofit cannot use this provider. Choose one from the list.");
  }
  const { name, keyUrl } = provider;
  const model = input.model ?? provider.model;
  const key = String(input.key ?? "").trim();

  if (!KEY_SHAPE.test(key)) {
    return fail("unauthorized", `This does not look like a ${name} key. Copy it again from ${keyUrl}.`);
  }

  const base = router.replace(/\/$/, "");
  // Anthropic's /models needs x-api-key, not Bearer; the plan checks the key on the first message.
  if (new URL(base).host === ANTHROPIC_HOST) return { ok: true, checkedOnFirstMessage: true };

  const doFetch: FetchFn = input.fetch ?? ((i, init) => globalThis.fetch(i, init));
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(input.timeoutMs ?? 15_000)
      : undefined;

  let response: Response;
  try {
    response = await doFetch(`${base}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (error instanceof TypeError) {
      return fail(
        "cors",
        `${name} did not answer from the browser. It may block requests from web pages, or you may be offline. Try again, or choose another provider under Advanced.`,
      );
    }
    return fail("network", `${name} did not answer in time. Try again.`);
  }

  if (response.status === 401 || response.status === 403) {
    return fail("unauthorized", `${name} did not accept this key. Check it at ${keyUrl}.`);
  }
  if (!response.ok) {
    return fail(
      "http",
      `${name} answered with an error (HTTP ${response.status}). Try again later, or check your key at ${keyUrl}.`,
    );
  }

  const body: unknown = await response.json().catch(() => null);
  const entries = modelIds(body);
  // Like the runtime (ui.js:1175-1185): only a non-empty list that lacks the model blocks.
  if (entries === null) return { ok: true };
  const match = entries.find((entry) => bareId(entry.id) === model);
  if (entries.length > 0 && !match) {
    return fail("model-missing", `${name} does not list the model ${model}. Choose another model under Advanced.`);
  }
  const price = priceOf(match);
  return price
    ? { ok: true, models: entries.map((e) => bareId(e.id)), pricePerMillion: price }
    : { ok: true, models: entries.map((e) => bareId(e.id)) };
}
