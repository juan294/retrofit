import { createFetchGuard, installFetchGuard, type FetchGuard } from "./fetch-guard";

let guard: FetchGuard | undefined;

/** The page's single fetch guard, created on first use in the browser. */
export function pageGuard(): FetchGuard {
  if (!guard) {
    const originalFetch = window.fetch.bind(window);
    guard = createFetchGuard({ pageOrigin: window.location.origin, originalFetch });
  }
  return guard;
}

/** Installs the page guard on window.fetch (reference counted) and returns the uninstall function. */
export function installPageGuard(): () => void {
  return installFetchGuard(window, pageGuard());
}
