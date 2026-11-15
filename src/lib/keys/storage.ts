// Visitor key storage, in the browser only. sessionStorage by default; localStorage only when the
// visitor ticks "Remember on this device". Every storage access is wrapped: private windows and
// blocked site data make Web Storage and document.cookie throw.

import type { Connection } from "./connect";

export const KEY_ITEM = "retrofit-key-v1";
const RUNTIME_PREFIX = "nsweb-byok-";
// The runtime's loopback mirror cookie (runtime/byok.js:12, :195).
const RUNTIME_COOKIE_EXPIRE = "nsweb_byok_profiles_v1=; Path=/; Max-Age=0; SameSite=Lax";

export type SavedKey = Connection;
export type LoadedKey = SavedKey & { remembered: boolean };

export type KeyStorageEnv = {
  session?: Storage | null;
  local?: Storage | null;
  document?: { cookie: string } | null;
};

function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function browserEnv(): KeyStorageEnv {
  return {
    session: attempt(() => globalThis.sessionStorage ?? null, null),
    local: attempt(() => globalThis.localStorage ?? null, null),
    document: attempt(() => (typeof document === "undefined" ? null : document), null),
  };
}

function parse(raw: string | null): SavedKey | null {
  if (!raw) return null;
  const value = attempt(() => JSON.parse(raw) as unknown, null);
  if (!value || typeof value !== "object") return null;
  const { provider, router, model, key } = value as Record<string, unknown>;
  const fields = [provider, router, model, key];
  if (!fields.every((f) => typeof f === "string" && f.length > 0)) return null;
  return { provider, router, model, key } as SavedKey;
}

export function saveKey(saved: SavedKey, options: { remember: boolean }, env: KeyStorageEnv = browserEnv()): void {
  const value = JSON.stringify({
    provider: saved.provider,
    router: saved.router,
    model: saved.model,
    key: saved.key,
  });
  const [target, other] = options.remember ? [env.local, env.session] : [env.session, env.local];
  attempt(() => other?.removeItem(KEY_ITEM), undefined);
  attempt(() => target?.setItem(KEY_ITEM, value), undefined);
}

/** The key for this tab first, else the remembered one. */
export function loadKey(env: KeyStorageEnv = browserEnv()): LoadedKey | null {
  const session = parse(attempt(() => env.session?.getItem(KEY_ITEM) ?? null, null));
  if (session) return { ...session, remembered: false };
  const local = parse(attempt(() => env.local?.getItem(KEY_ITEM) ?? null, null));
  return local ? { ...local, remembered: true } : null;
}

function clearPrefixed(storage: Storage | null | undefined): void {
  if (!storage) return;
  const names = attempt(() => {
    const found: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const name = storage.key(i);
      if (name !== null && (name.startsWith(KEY_ITEM) || name.startsWith(RUNTIME_PREFIX))) found.push(name);
    }
    return found;
  }, [] as string[]);
  for (const name of names) attempt(() => storage.removeItem(name), undefined);
}

/** Clears Retrofit's key, every runtime `nsweb-byok-*` item in both storages, and the runtime cookie. */
export function forgetAll(env: KeyStorageEnv = browserEnv()): void {
  clearPrefixed(env.session);
  clearPrefixed(env.local);
  attempt(() => {
    if (env.document) env.document.cookie = RUNTIME_COOKIE_EXPIRE;
  }, undefined);
}
