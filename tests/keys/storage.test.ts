import { describe, expect, it } from "vitest";
import { forgetAll, loadKey, saveKey, type KeyStorageEnv, type SavedKey } from "@/lib/keys/storage";

/** Minimal in-memory Web Storage at the browser boundary (no jsdom in this project). */
class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.has(key) ? this.items.get(key)! : null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
  keys() {
    return [...this.items.keys()];
  }
}

/** Records cookie writes the way document.cookie does: one name=value per assignment. */
class CookieJar {
  writes: string[] = [];
  private jar = new Map<string, string>();
  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  set cookie(line: string) {
    this.writes.push(line);
    const [pair, ...attrs] = line.split(";").map((s) => s.trim());
    const [name, value = ""] = pair!.split("=");
    const expired = attrs.some((a) => /^max-age=0$/i.test(a));
    if (expired) this.jar.delete(name!);
    else this.jar.set(name!, value);
  }
}

function env() {
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  const document = new CookieJar();
  return { session, local, document, env: { session, local, document } satisfies KeyStorageEnv };
}

const SAVED: SavedKey = {
  provider: "Groq",
  router: "https://api.groq.com/openai/v1",
  model: "openai/gpt-oss-120b",
  key: "gsk_secret",
};

describe("key storage", () => {
  // Fails when the default save writes to localStorage (the key would outlive the tab).
  it("saves to sessionStorage by default", () => {
    const e = env();
    saveKey(SAVED, { remember: false }, e.env);
    expect(e.local.length).toBe(0);
    expect(e.session.keys().every((k) => k.startsWith("retrofit-key-v1"))).toBe(true);
    expect(loadKey(e.env)).toEqual({ ...SAVED, remembered: false });
  });

  // Fails when "Remember on this device" does not move the key to localStorage only.
  it("saves to localStorage only when remembered", () => {
    const e = env();
    saveKey(SAVED, { remember: false }, e.env);
    saveKey(SAVED, { remember: true }, e.env);
    expect(e.session.length).toBe(0);
    expect(e.local.keys().every((k) => k.startsWith("retrofit-key-v1"))).toBe(true);
    expect(loadKey({ session: new MemoryStorage(), local: e.local, document: e.document })).toEqual({
      ...SAVED,
      remembered: true,
    });
    // Unticking later removes the remembered copy.
    saveKey(SAVED, { remember: false }, e.env);
    expect(e.local.length).toBe(0);
  });

  // Fails when a malformed or partial item is returned as a usable key.
  it("ignores a damaged item", () => {
    const e = env();
    e.session.setItem("retrofit-key-v1", "{not json");
    expect(loadKey(e.env)).toBeNull();
    e.session.setItem("retrofit-key-v1", JSON.stringify({ provider: "Groq", key: "" }));
    expect(loadKey(e.env)).toBeNull();
  });

  // Fails when forgetAll misses Retrofit's items, any nsweb-byok-* item, or the runtime cookie,
  // or when it removes unrelated items.
  it("forgetAll clears Retrofit items, every nsweb-byok-* item and the runtime cookie", () => {
    const e = env();
    saveKey(SAVED, { remember: true }, e.env);
    e.session.setItem("retrofit-key-v1", "x");
    for (const s of [e.session, e.local]) {
      s.setItem("nsweb-byok-profiles-v1", "{}");
      s.setItem("nsweb-byok-tab-key", "k");
      s.setItem("nsweb-byok-key", "k");
      s.setItem("nsweb-byok-router", "r");
      s.setItem("nsweb-byok-model", "m");
      s.setItem("nsweb-byok-future-item", "f");
      s.setItem("unrelated", "keep");
    }
    e.document.cookie = "nsweb_byok_profiles_v1=abc; Path=/; Max-Age=100; SameSite=Lax";
    e.document.cookie = "other=1";

    forgetAll(e.env);

    expect(e.session.keys()).toEqual(["unrelated"]);
    expect(e.local.keys()).toEqual(["unrelated"]);
    expect(e.document.cookie).toBe("other=1");
    expect(e.document.writes.at(-1)).toMatch(/^nsweb_byok_profiles_v1=; Path=\/; Max-Age=0/);
    expect(loadKey(e.env)).toBeNull();
  });

  // Fails when a storage access that throws (private mode, blocked site data) escapes.
  it("survives storage that throws", () => {
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new DOMException("blocked", "SecurityError");
        },
      },
    ) as Storage;
    const badCookie = {
      get cookie(): string {
        throw new DOMException("blocked", "SecurityError");
      },
      set cookie(_v: string) {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    const e = { session: throwing, local: throwing, document: badCookie };
    expect(() => saveKey(SAVED, { remember: true }, e)).not.toThrow();
    expect(loadKey(e)).toBeNull();
    expect(() => forgetAll(e)).not.toThrow();
  });
});
