// The key panel's submit flow, kept out of the component so it is testable without a DOM.
// Order (phase-4.md "Preview adapter and fetch guard"): authorize the provider in the fetch guard
// right before validation; on failure revoke it. On success the caller reboots the preview, then
// calls guard.setRouter and guard.revokeProvider.

import type { FetchGuard } from "@/lib/preview/fetch-guard";
import { detectProvider } from "./detect";
import { PROVIDERS, providerForRouter, type Provider } from "./providers";
import { UNSUPPORTED_PROVIDER, testKey, type PricePerMillion } from "./test-key";

export type KeyGuard = Pick<FetchGuard, "authorizeProvider" | "revokeProvider">;

export type Connection = { provider: string; router: string; model: string; key: string };

export type ConnectResult =
  | { ok: true; connection: Connection; price: string; note: string | null }
  | { ok: false; message: string };

export type ConnectInput = {
  guard: KeyGuard;
  key: string;
  /** Advanced choice; must be a router in providers.ts. Empty means "match my key". */
  router?: string;
  /** Advanced choice; empty means the provider's default model. */
  model?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

const ALL_PREFIXES = PROVIDERS.flatMap((p) => p.keyPrefixes);
const UNRECOGNIZED = `Retrofit did not recognize this key. Keys we know start with ${ALL_PREFIXES.slice(0, -1).join(", ")} or ${ALL_PREFIXES.at(-1)}. Check the key, or choose your provider under Advanced.`;

function dollars(n: number): string {
  return n === 0 || n >= 0.01 ? n.toFixed(2) : n.toPrecision(2);
}

export function priceText(price: PricePerMillion | undefined): string {
  if (!price) return "Cost depends on your provider.";
  return `About $${dollars(price.input)} per million input tokens and $${dollars(price.output)} per million output tokens.`;
}

export async function connectKey(input: ConnectInput): Promise<ConnectResult> {
  const key = String(input.key ?? "").trim();
  if (!key) return { ok: false, message: "Paste your key first." };

  let provider: Provider | null;
  if (input.router) {
    provider = providerForRouter(input.router);
    if (!provider) return { ok: false, message: UNSUPPORTED_PROVIDER };
  } else {
    provider = detectProvider(key);
    if (!provider) return { ok: false, message: UNRECOGNIZED };
  }
  const router = provider.router;
  const model = input.model?.trim() || provider.model;

  input.guard.authorizeProvider(router);
  const result = await testKey({ provider, router, key, model, fetch: input.fetch });
  if (!result.ok) {
    input.guard.revokeProvider();
    return { ok: false, message: result.message };
  }
  return {
    ok: true,
    connection: { provider: provider.name, router, model, key },
    price: priceText(result.pricePerMillion),
    note: result.checkedOnFirstMessage ? `${provider.name} checks the key when you send your first message.` : null,
  };
}
