// Preview fetch guard (Phase 4, parent plan "Destination containment", facts 10 and 17).
// Framework-free: no React and no DOM globals at import time. Preview.tsx creates one guard
// per page, installs it on window before boot, and replaces its state on every reboot.

export const BLOCKED_TEXT = (origin: string): string =>
  `Retrofit blocked a request to ${origin} that was not approved.`;

type FetchInput = RequestInfo | URL;
type FetchFn = (input: FetchInput, init?: RequestInit) => Promise<Response>;

/** The engine's consent hook (runtime/engine.js:130-141): `info.peerOrigin` is `URL.host`. */
export type ConsentInfo = { peerOrigin?: unknown; [key: string]: unknown };
export type RequestConsent<This = unknown> = (this: This, info: ConsentInfo) => unknown;

export type FetchGuardState = {
  readonly pageOrigin: string;
  readonly router: string | null;
  readonly provisionalProvider: string | null;
  readonly policyPeers: readonly string[];
  readonly approvedPeers: readonly string[];
};

export type FetchGuard = {
  readonly fetch: (input: FetchInput, init?: RequestInit) => Promise<Response>;
  setRouter(routerBaseUrl: string | null): void;
  setPolicyPeers(origins: readonly string[]): void;
  clearApprovals(): void;
  approveFromConsent(peerOriginHostPort: string): string | null;
  wrapRequestConsent<This>(original: RequestConsent<This>): (this: This, info: ConsentInfo) => Promise<unknown>;
  authorizeProvider(routerBaseUrl: string): void;
  revokeProvider(): void;
  state(): FetchGuardState;
};

export type FetchGuardOptions = {
  pageOrigin: string;
  originalFetch: FetchFn;
  log?: (message: string) => void;
};

type Router = { base: string; origin: string; path: string };

function parseRouter(routerBaseUrl: string): Router {
  const url = new URL(routerBaseUrl);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.search || url.hash) {
    throw new TypeError(`Router base URL must be an http(s) URL without query or fragment: ${routerBaseUrl}`);
  }
  // The runtime strips one trailing slash before appending paths (runtime/llm.js:55, ui.js:1088).
  const path = url.pathname.replace(/\/$/, "");
  return { base: `${url.origin}${path}`, origin: url.origin, path };
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isArtifactPath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return (
    path === "/p" ||
    path.startsWith("/p/") ||
    path === "/agent-manifest.json" ||
    path === "/links.json" ||
    path.endsWith(".network.json")
  );
}

function rawUrl(input: FetchInput): string {
  if (input instanceof URL) return input.href;
  return typeof input === "string" ? input : input.url;
}

function requestMethod(input: FetchInput, init: RequestInit | undefined): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === "object" && !(input instanceof URL)) return input.method.toUpperCase();
  return "GET";
}

export function createFetchGuard(options: FetchGuardOptions): FetchGuard {
  const pageOrigin = new URL(options.pageOrigin).origin;
  const originalFetch = options.originalFetch;
  const log = options.log ?? ((message: string) => console.warn(message));

  let router: Router | null = null;
  let provisional: Router | null = null;
  let policyPeers = new Set<string>();
  let approvedPeers = new Set<string>();

  const routerAllows = (r: Router, method: string, url: URL): boolean =>
    url.origin === r.origin &&
    url.search === "" &&
    ((method === "POST" && url.pathname === `${r.path}/chat/completions`) ||
      (method === "GET" && url.pathname === `${r.path}/models`) ||
      (method === "GET" && url.pathname === "/agent-manifest.json"));

  const providerAllows = (p: Router, method: string, url: URL): boolean =>
    url.origin === p.origin && url.search === "" && method === "GET" && url.pathname === `${p.path}/models`;

  // fetch(input, init) builds new Request(input, init): init fields override a Request's own,
  // and its body and headers are kept, so only `redirect` changes.
  const withRedirectError = (input: FetchInput, init: RequestInit | undefined): Promise<Response> =>
    originalFetch(input, { ...init, redirect: "error" });

  // async: a refusal rejects (as the platform fetch does) and never reaches originalFetch.
  async function guardedFetch(input: FetchInput, init?: RequestInit): Promise<Response> {
    let url: URL;
    try {
      url = new URL(rawUrl(input), pageOrigin);
    } catch {
      throw new TypeError(BLOCKED_TEXT(rawUrl(input)));
    }

    // 1 and 2: same origin; agent artifacts must not follow redirects.
    if (url.origin === pageOrigin) {
      return isArtifactPath(url.pathname) ? withRedirectError(input, init) : originalFetch(input, init);
    }

    const method = requestMethod(input, init);

    // 3 and 4: the router and the provisional provider origins are limited to their own
    // requests, even when the same origin is also an approved policy peer.
    const onRouter = router !== null && url.origin === router.origin;
    const onProvider = provisional !== null && url.origin === provisional.origin;
    if (onRouter || onProvider) {
      const allowed =
        (onRouter && router !== null && routerAllows(router, method, url)) ||
        (onProvider && provisional !== null && providerAllows(provisional, method, url));
      if (allowed) return withRedirectError(input, init);
      throw new TypeError(BLOCKED_TEXT(url.origin));
    }

    // 5: any other origin needs the manifest policy and the visitor's approval.
    if (policyPeers.has(url.origin) && approvedPeers.has(url.origin)) return withRedirectError(input, init);
    throw new TypeError(BLOCKED_TEXT(url.origin !== "null" ? url.origin : url.protocol));
  }

  function approveFromConsent(peerOriginHostPort: string): string | null {
    const host = String(peerOriginHostPort).toLowerCase();
    const matches = [...policyPeers].filter((origin) => new URL(origin).host === host);
    if (matches.length !== 1) {
      log(`Retrofit approved no peer for ${host}: ${matches.length} configured origins match (${matches.join(", ") || "none"}).`);
      return null;
    }
    const origin = matches[0]!;
    approvedPeers.add(origin);
    return origin;
  }

  return {
    fetch: guardedFetch,
    setRouter(routerBaseUrl) {
      router = routerBaseUrl === null ? null : parseRouter(routerBaseUrl);
    },
    setPolicyPeers(origins) {
      const next = new Set<string>();
      for (const value of origins) {
        const origin = normalizeOrigin(value);
        if (origin) next.add(origin);
        else log(`Retrofit ignored an invalid peer origin: ${value}`);
      }
      policyPeers = next;
      approvedPeers = new Set([...approvedPeers].filter((origin) => next.has(origin)));
    },
    clearApprovals() {
      approvedPeers = new Set();
    },
    approveFromConsent,
    wrapRequestConsent<This>(original: RequestConsent<This>) {
      return async function wrappedRequestConsent(this: This, info: ConsentInfo) {
        const decision = await original.call(this, info);
        if (decision === "allow" && typeof info?.peerOrigin === "string") approveFromConsent(info.peerOrigin);
        return decision;
      };
    },
    authorizeProvider(routerBaseUrl) {
      provisional = parseRouter(routerBaseUrl);
    },
    revokeProvider() {
      provisional = null;
    },
    state() {
      return {
        pageOrigin,
        router: router?.base ?? null,
        provisionalProvider: provisional?.base ?? null,
        policyPeers: [...policyPeers],
        approvedPeers: [...approvedPeers],
      };
    },
  };
}

type Installation = { guard: FetchGuard; previous: typeof fetch; count: number };
const installations = new WeakMap<object, Installation>();

/**
 * Installs the guard as `target.fetch` once per page while any preview is mounted and returns
 * a release function. The original fetch comes back when the last holder releases. Each
 * release function counts once, so a repeated cleanup cannot release another holder.
 */
export function installFetchGuard(target: { fetch: typeof fetch }, guard: FetchGuard): () => void {
  let installation = installations.get(target);
  if (installation && installation.guard !== guard) {
    throw new Error("A different fetch guard is already installed on this page; reuse it and replace its state.");
  }
  if (!installation) {
    installation = { guard, previous: target.fetch, count: 0 };
    installations.set(target, installation);
    target.fetch = guard.fetch as typeof fetch;
  }
  installation.count += 1;
  const held = installation;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.count -= 1;
    if (held.count === 0) {
      target.fetch = held.previous;
      installations.delete(target);
    }
  };
}
