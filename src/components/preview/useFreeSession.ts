"use client";

import { useEffect, useState } from "react";
import { FREE_PLACEHOLDER_KEY, UNAVAILABLE_MESSAGE } from "@/lib/inference/errors";
import type { Inference } from "./Preview";

export const RENEW_EVERY_MS = 30 * 60 * 1000;

export type FreeState =
  | { readonly status: "starting" }
  | { readonly status: "ready"; readonly inference: Inference }
  | { readonly status: "unavailable"; readonly message: string };

async function startSession(): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await fetch("/api/inference/session", { method: "POST", credentials: "same-origin" });
  // Always read the body, so the response completes (an unread body keeps the request open).
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  if (res.ok) return { ok: true };
  return { ok: false, message: body?.message ?? UNAVAILABLE_MESSAGE };
}

async function freeModel(): Promise<string | null> {
  const res = await fetch("/api/inference/v1/models", { credentials: "same-origin", cache: "no-store" });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
  const id = body?.data?.[0]?.id;
  return typeof id === "string" ? id : null;
}

/**
 * Retrofit's free path: a session cookie scoped to /api/inference, renewed every
 * 30 minutes and when the tab becomes visible, and the runtime booted with the
 * placeholder key and Retrofit's own router. `active` false stops it (a visitor key is in use).
 */
export function useFreeSession(active: boolean): FreeState {
  const [state, setState] = useState<FreeState>({ status: "starting" });
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const begin = async () => {
      try {
        const started = await startSession();
        if (stopped) return;
        if (!started.ok) return setState({ status: "unavailable", message: started.message });
        const model = await freeModel();
        if (stopped) return;
        if (!model) return setState({ status: "unavailable", message: UNAVAILABLE_MESSAGE });
        setState({ status: "ready", inference: { router: `${window.location.origin}/api/inference/v1`, key: FREE_PLACEHOLDER_KEY, model } });
      } catch {
        if (!stopped) setState({ status: "unavailable", message: UNAVAILABLE_MESSAGE });
      }
    };
    void begin();
    // Renewal keeps the same session (sid, pool and counters); it never reboots the runtime.
    const renew = () => void startSession().catch(() => undefined);
    const timer = setInterval(renew, RENEW_EVERY_MS);
    const onVisible = () => document.visibilityState === "visible" && renew();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active]);
  return state;
}
