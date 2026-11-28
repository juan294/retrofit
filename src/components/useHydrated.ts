"use client";

import { useSyncExternalStore } from "react";

const noSubscription = () => () => {};

/**
 * False in the server HTML and until hydration, true after it. Forms keep their submit button
 * disabled until then, so an early click can never submit them as a plain GET.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(noSubscription, () => true, () => false);
}
