"use client";

import { useCallback, useEffect, useState } from "react";
import type { Connection } from "@/lib/keys/connect";
import { loadUsableKey } from "@/lib/keys/storage";
import type { Inference } from "./Preview";

export interface OwnKey {
  /** The connected key, or null. */
  readonly ownKey: Inference | null;
  /** Absolute base of the network, or null until the page mounted (the origin is known only in the browser). */
  readonly originUrl: string | null;
  /** A remembered key restores itself in the key panel. */
  readonly hasStoredKey: boolean;
  readonly onConnect: (c: Connection) => void;
  readonly onForget: () => void;
}

/** The visitor's own key for one agent panel, whose network base is `basePath` on this origin. */
export function useOwnKey(basePath: string): OwnKey {
  const [ownKey, setOwnKey] = useState<Inference | null>(null);
  // The runtime needs an absolute base (research §4); the origin is known only in the browser.
  const [originUrl, setOriginUrl] = useState<string | null>(null);
  // A remembered key restores itself in the key panel; the free path must not start (and count a session) first.
  const [hasStoredKey, setHasStoredKey] = useState(false);
  useEffect(() => {
    // Same rule as the key panel's restore.
    setHasStoredKey(loadUsableKey() !== null);
    setOriginUrl(`${window.location.origin}${basePath}`);
  }, [basePath]);

  const onConnect = useCallback((c: Connection) => setOwnKey({ router: c.router, key: c.key, model: c.model }), []);
  const onForget = useCallback(() => {
    setHasStoredKey(false);
    setOwnKey(null);
  }, []);
  return { ownKey, originUrl, hasStoredKey, onConnect, onForget };
}
