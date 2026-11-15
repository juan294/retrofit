// Preview fetch guard (Phase 4, parent plan "Destination containment", facts 10 and 17).
// Framework-free: no React and no DOM globals at import time. Preview.tsx creates one guard
// per page, installs it on window before boot, and replaces its state on every reboot.

export const BLOCKED_TEXT = (origin: string): string =>
  `Retrofit blocked a request to ${origin} that was not approved.`;

/** A guarded request answered with a redirect. The target stays unknown and is never contacted. */
export const REDIRECT_BLOCKED_TEXT = (origin: string): string =>
  `Retrofit blocked a redirect from ${origin} to an address that was not approved.`;

/**
 * A request from a runtime that a newer preview replaced (a provider switch, "Forget my key"
 * or a reboot). The unchanged runtime cannot be stopped, so the guard refuses its model calls
 * and aborts the ones still waiting for an answer.
 */
export const RETIRED_TEXT = "Retrofit stopped a request from an agent that was replaced.";

/**
 * Marker segment the guard adds to the router base it gives one runtime
 * (`<router>/~retrofit-run-<n>`). The guard maps it back to the router path and
 * refuses it once that runtime is retired.
 */
const RUN_MARKER = /\/~retrofit-run-(\d+)(?=\/|$)/;

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
  /**
   * Replaces the active router and retires the previous runtime: its model calls are refused
   * and its pending ones are aborted. Returns the router base to give the new runtime, or null.
   */
  setRouter(routerBaseUrl: string | null): string | null;
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
  // One runtime at a time may use the router through its own marked base.
  let generation = 0;
  let run: { id: number; controller: AbortController } | null = null;
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
  // and its body and headers are kept, so only `redirect` changes. "manual" never follows a
  // redirect (like "error"); the guard then refuses the redirect with a text the visitor can read.
  const withRedirectError = async (input: FetchInput, init: RequestInit | undefined): Promise<Response> => {
    const res = await originalFetch(input, { ...init, redirect: "manual" });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      throw new TypeError(REDIRECT_BLOCKED_TEXT(new URL(rawUrl(input), pageOrigin).origin));
    }
    return res;
  };

  // A runtime's model call: only the active runtime's marker under the active router is mapped
  // to the router path, with that runtime's abort signal added to the caller's own.
  const fromRuntime = (input: FetchInput, init: RequestInit | undefined, url: URL, marker: RegExpExecArray): [FetchInput, RequestInit] => {
    const prefix = url.pathname.slice(0, marker.index);
    if (router === null || run === null || marker[1] !== String(run.id) || `${url.origin}${prefix}` !== router.base) {
      throw new TypeError(RETIRED_TEXT);
    }
    const target = `${url.origin}${prefix}${url.pathname.slice(marker.index + marker[0].length)}${url.search}`;
    const request = typeof input === "object" && !(input instanceof URL) ? input : null;
    const callerSignal = init?.signal ?? request?.signal;
    const signal = callerSignal ? AbortSignal.any([callerSignal, run.controller.signal]) : run.controller.signal;
    return [request ? new Request(target, request) : target, { ...init, signal }];
  };

  // async: a refusal rejects (as the platform fetch does) and never reaches originalFetch.
  async function guardedFetch(input: FetchInput, init?: RequestInit): Promise<Response> {
    let url: URL;
    try {
      url = new URL(rawUrl(input), pageOrigin);
    } catch {
      throw new TypeError(BLOCKED_TEXT(rawUrl(input)));
    }

    const marker = RUN_MARKER.exec(url.pathname);
    if (marker) {
      [input, init] = fromRuntime(input, init, url, marker);
      url = new URL(rawUrl(input), pageOrigin);
    } else if (run !== null && router?.origin === pageOrigin && url.origin === pageOrigin && url.pathname.replace(/\/$/, "") === `${router.path}/chat/completions`) {
      // While a runtime is active, only its marked base reaches a same-origin router's model calls.
      throw new TypeError(BLOCKED_TEXT(url.origin));
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
      const next = routerBaseUrl === null ? null : parseRouter(routerBaseUrl);
      run?.controller.abort(new TypeError(RETIRED_TEXT));
      run = null;
      router = next;
      if (next === null) return null;
      generation += 1;
      run = { id: generation, controller: new AbortController() };
      return `${next.base}/~retrofit-run-${run.id}`;
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
