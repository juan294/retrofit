import { PROVIDERS, type Provider } from "./providers";

/**
 * The provider whose longest key prefix matches the trimmed key, else null.
 * The runtime's providerForApiKey takes the first row in table order (ui.js:77-83); the longest
 * prefix keeps `sk-or-v1-` and `sk-ant-` correct if a shorter `sk-` row is ever added.
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
