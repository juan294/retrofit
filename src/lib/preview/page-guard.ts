import { createFetchGuard, installFetchGuard, type FetchGuard } from "./fetch-guard";

let guard: FetchGuard | undefined;
let installed = false;

/** The page's single fetch guard, created on first use in the browser. */
export function pageGuard(): FetchGuard {
  if (!guard) {
    const originalFetch = window.fetch.bind(window);
    guard = createFetchGuard({ pageOrigin: window.location.origin, originalFetch });
  }
  return guard;
}

/**
 * Installs the page guard on window.fetch once. It stays installed for the
 * page's life: the vendored runtime cannot be stopped (no dispose or abort),
 * so a runtime that outlives its preview must still meet the guard.
 */
export function installPageGuard(target: { fetch: typeof fetch } = window): FetchGuard {
  const g = pageGuard();
  if (!installed) {
    installFetchGuard(target, g);
    installed = true;
  }
  return g;
}

/**
 * Closes every cross-origin destination when a preview unmounts ("Forget my
 * key", a key change or navigation): no router, no policy peers, no approvals,
 * no provisional provider. A runtime still running gets the blocked error.
 */
export function closePreviewAccess(g: Pick<FetchGuard, "setRouter" | "setPolicyPeers" | "clearApprovals" | "revokeProvider">, w: object = window): void {
  g.setRouter(null);
  g.setPolicyPeers([]);
  g.clearApprovals();
  g.revokeProvider();
  // The runtime exposes its engine (and with it the key) on window.__nsweb.
  delete (w as { __nsweb?: unknown }).__nsweb;
}
