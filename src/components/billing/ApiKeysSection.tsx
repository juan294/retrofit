"use client";

import { useState, type FormEvent } from "react";
import type { ApiKeyView } from "@/lib/api/api-keys";
import { API_KEY_TEXT as T } from "@/lib/site/billing-texts";
import { postJson, statusOf, type Status } from "../post";
import { StatusMessage } from "../StatusMessage";
import { useHydrated } from "../useHydrated";

interface Answer {
  readonly key?: unknown;
  readonly apiKey?: ApiKeyView;
}

const border = { borderColor: "var(--color-border)" };
const accent = { background: "var(--color-accent)", color: "var(--color-accent-text)" };

/**
 * "API keys" on /account: the active keys (their last characters only), create and revoke. A new key
 * lives only in this component's state, so it is shown once: a reload shows only its last characters.
 */
export function ApiKeysSection({ keys }: { keys: readonly ApiKeyView[] }) {
  const [list, setList] = useState(keys);
  const [shown, setShown] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();

  async function send(path: string, body: Record<string, string>, done: (answer: Answer) => void): Promise<void> {
    setBusy(true);
    setStatus(null);
    setShown(null);
    const answer = await postJson<Answer>(path, body);
    setStatus(statusOf(answer, T.unavailable));
    if (answer.ok && answer.body) done(answer.body);
    setBusy(false);
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send("/api/account/keys", {}, ({ key, apiKey }) => {
      if (typeof key === "string") setShown(key);
      if (apiKey) setList((l) => [...l, apiKey]);
    });
  }
  const revoke = (keyId: string) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send("/api/account/keys/revoke", { keyId }, () => setList((l) => l.filter((k) => k.id !== keyId)));
  };
  const disabled = busy || !hydrated;

  return (
    <section data-testid="api-keys">
      <h2 className="mt-10 text-xl font-semibold">{T.heading}</h2>
      <p className="mt-2 break-words">{T.intro}</p>
      <form method="post" action="/api/account/keys" onSubmit={create} className="mt-3">
        <button type="submit" disabled={disabled} className="rounded px-4 py-2 font-medium" style={accent}>
          {busy ? T.busy : T.create}
        </button>
      </form>
      <StatusMessage status={status} testId="api-keys-message" className="mt-2" />
      {shown ? (
        <code className="mt-2 block rounded border p-2 text-sm break-all" style={{ ...border, background: "var(--color-surface)" }} data-testid="api-key">
          {shown}
        </code>
      ) : null}
      {list.length === 0 ? (
        <p className="mt-2">{T.none}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {list.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-3 rounded border p-3" style={border} data-testid="api-key-item">
              <span>{T.item(k.hint, k.createdOn)}</span>
              <form method="post" action="/api/account/keys/revoke" onSubmit={revoke(k.id)}>
                <button type="submit" disabled={disabled} className="rounded border px-3 py-1" style={border}>
                  {T.revoke}
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
