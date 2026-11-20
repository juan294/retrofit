import { PROVIDERS, type Provider } from "./providers";

/**
 * The provider whose longest key prefix matches the trimmed key, else null.
 * Same rule as the runtime's providerForApiKey (public/runtime/ui.js:101-115): the longest prefix
 * wins, so an EU Otari key (`otk_v1_eu_`) finds the "Otari EU" row and not the general `otk_` row.
 */
export function detectProvider(key: string, providers: readonly Provider[] = PROVIDERS): Provider | null {
  const trimmed = String(key ?? "").trim();
  if (!trimmed) return null;
  let best: Provider | null = null;
  let bestLength = 0;
  for (const provider of providers) {
    for (const prefix of provider.keyPrefixes) {
      if (prefix.length > bestLength && trimmed.startsWith(prefix)) {
        best = provider;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}
