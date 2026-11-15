import type { BrowserContext, Page, Request } from "@playwright/test";

export type { BrowserContext, Page };
/** Retrofit's own origin in the e2e run (playwright.config.ts BASE_URL). */
export const RETROFIT_ORIGIN = "http://127.0.0.1:3010";

export interface RecordedRequest {
  readonly url: string;
  readonly origin: string;
  readonly method: string;
  /** Every header the browser sent, including Cookie (Playwright `allHeaders`). */
  readonly headers: Record<string, string>;
  /** The request body as Latin-1 text, or "" when there is none. */
  readonly body: string;
  readonly resourceType: string;
}

export interface RequestLog {
  /** Waits for pending header reads and returns every request seen so far. */
  all(): Promise<RecordedRequest[]>;
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "invalid";
  }
};

/**
 * Records every request that pages in `target` start, including requests that a
 * Playwright route fulfills (the scripted routers). A context target also covers
 * pages opened later.
 */
export function recordRequests(target: Page | BrowserContext): RequestLog {
  const pending: Promise<RecordedRequest>[] = [];
  const onRequest = (req: Request) => {
    pending.push(
      (async () => {
        const headers = await req.allHeaders().catch(() => req.headers());
        return {
          url: req.url(),
          origin: originOf(req.url()),
          method: req.method(),
          headers,
          body: req.postDataBuffer()?.toString("latin1") ?? "",
          resourceType: req.resourceType(),
        };
      })(),
    );
  };
  target.on("request", onRequest);
  const all = async () => (await Promise.all(pending)).filter((r) => !/^(data|blob):/.test(r.url));
  return { all };
}

/** The places in one request where `secret` appears: url, a header name, body. */
export function whereSecretAppears(r: RecordedRequest, secret: string): string[] {
  const found: string[] = [];
  const variants = [secret, encodeURIComponent(secret)];
  const has = (text: string) => variants.some((v) => text.includes(v));
  if (has(r.url)) found.push("url");
  for (const [name, value] of Object.entries(r.headers)) if (has(value)) found.push(`header ${name}`);
  if (has(r.body)) found.push("body");
  return found;
}

/** Names written through Storage.setItem and document.cookie, recorded from page start. */
export async function recordStorageWrites(page: Page): Promise<() => Promise<{ local: string[]; session: string[]; cookies: string[] }>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __storageWrites?: { local: string[]; session: string[]; cookies: string[] } };
    if (w.__storageWrites) return;
    const log = { local: [] as string[], session: [] as string[], cookies: [] as string[] };
    w.__storageWrites = log;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, name: string, value: string) {
      (this === window.sessionStorage ? log.session : log.local).push(String(name));
      return setItem.call(this, name, value);
    };
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    if (desc?.set && desc.get) {
      Object.defineProperty(Document.prototype, "cookie", {
        configurable: true,
        get() {
          return desc.get!.call(this);
        },
        set(v: string) {
          log.cookies.push(String(v).split("=")[0]!.trim());
          desc.set!.call(this, v);
        },
      });
    }
  });
  return () =>
    page.evaluate(() => {
      const w = window as unknown as { __storageWrites?: { local: string[]; session: string[]; cookies: string[] } };
      return w.__storageWrites ?? { local: [], session: [], cookies: [] };
    });
}

/** Every item name in localStorage and sessionStorage, and every cookie name visible to the page. */
export function storageNames(page: Page): Promise<{ local: string[]; session: string[]; cookies: string[] }> {
  return page.evaluate(() => {
    const names = (s: Storage) => Array.from({ length: s.length }, (_, i) => s.key(i)!).filter(Boolean);
    return {
      local: names(window.localStorage),
      session: names(window.sessionStorage),
      cookies: document.cookie
        .split(";")
        .map((c) => c.split("=")[0]!.trim())
        .filter(Boolean),
    };
  });
}
