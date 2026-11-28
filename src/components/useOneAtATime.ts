"use client";

import { useState } from "react";

/** Runs `work` under `key`. Ignored while an earlier action works. Work that answers "leaving" keeps the page busy: it navigates. */
export type RunAction = (key: string, work: () => Promise<"leaving" | void>) => Promise<void>;

/** The guard behind useOneAtATime. `onBusy` gets the key of the action that works, then null. */
export function createGate(onBusy: (key: string | null) => void): RunAction {
  let working = false;
  return async (key, work) => {
    if (working) return;
    working = true;
    onBusy(key);
    let leaving = false;
    try {
      leaving = (await work()) === "leaving";
    } finally {
      if (!leaving) {
        working = false;
        onBusy(null);
      }
    }
  };
}

/** One request at a time for one form or section: a press while one works does nothing. `busy` is the key of the action that works. */
export function useOneAtATime(): { busy: string | null; run: RunAction } {
  const [busy, setBusy] = useState<string | null>(null);
  const [run] = useState(() => createGate(setBusy));
  return { busy, run };
}

/** A button's state: really disabled only before hydration. A working one keeps the keyboard focus (aria-disabled); the guard above ignores its presses. */
export const buttonState = (hydrated: boolean, busy: boolean) => ({ disabled: !hydrated, "aria-disabled": busy || undefined });
