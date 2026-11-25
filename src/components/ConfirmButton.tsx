"use client";

import { useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { buttonState } from "./useOneAtATime";

const border = { borderColor: "var(--color-border)" };

interface Props {
  readonly label: string;
  /** The second step: what ends, and its two buttons. */
  readonly question: string;
  readonly confirm: string;
  readonly cancel: string;
  /** A button's accessible name, from its text. */
  readonly name: (label: string) => string;
  readonly hydrated: boolean;
  readonly busy: boolean;
  readonly onConfirm: () => void;
}

/** A button whose action cannot be undone: it opens a second step in place, with the keyboard focus on it; cancelling returns the focus to the button. */
export function ConfirmButton(p: Props) {
  const [asking, setAsking] = useState(false);
  const step = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const questionId = useId();
  const state = buttonState(p.hydrated, p.busy);

  function ask(on: boolean) {
    if (p.busy) return;
    flushSync(() => setAsking(on));
    (on ? step : first).current?.focus();
  }

  if (!asking) {
    return (
      <button ref={first} type="button" onClick={() => ask(true)} aria-label={p.name(p.label)} {...state} className="rounded border px-4 py-2" style={border}>
        {p.label}
      </button>
    );
  }
  return (
    <div ref={step} role="group" tabIndex={-1} aria-labelledby={questionId} className="w-full rounded border p-3" style={border} data-testid="second-step">
      <p id={questionId} className="break-words" style={{ color: "var(--color-danger)" }}>
        {p.question}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={p.onConfirm} aria-label={p.name(p.confirm)} {...state} className="rounded border px-4 py-2" style={border}>
          {p.confirm}
        </button>
        <button type="button" onClick={() => ask(false)} aria-label={p.name(p.cancel)} {...state} className="rounded border px-4 py-2" style={border}>
          {p.cancel}
        </button>
      </div>
    </div>
  );
}
