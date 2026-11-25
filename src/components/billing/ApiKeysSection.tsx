"use client";

import { useState, type FormEvent } from "react";
import type { ApiKeyView } from "@/lib/api/api-keys";
import { API_KEY_TEXT as T } from "@/lib/site/billing-texts";
import { ConfirmButton } from "../ConfirmButton";
import { postJson, statusOf, type Status } from "../post";
import { StatusMessage } from "../StatusMessage";
import { useFocusFallback } from "../useFocusFallback";
import { useHydrated } from "../useHydrated";
import { buttonState, useOneAtATime } from "../useOneAtATime";

interface Answer {
  readonly key?: unknown;
  readonly apiKey?: ApiKeyView;
}

const border = { borderColor: "var(--color-border)" };
const accent = { background: "var(--color-accent)", color: "var(--color-accent-text)" };

/**
 * "API keys" on /account: the active keys (their last characters only), create and revoke (which asks first). A new key
 * lives only in this component's state, so it is shown once: a reload shows only its last characters.
 */
export function ApiKeysSection({ keys }: { keys: readonly ApiKeyView[] }) {
  const [list, setList] = useState(keys);
  const [shown, setShown] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const { busy, run } = useOneAtATime();
  const { heading, section } = useFocusFallback();
  const hydrated = useHydrated();

  const send = (path: string, body: Record<string, string>, done: (answer: Answer) => void) =>
    run(path, async () => {
      setStatus(null);
      setShown(null);
      const answer = await postJson<Answer>(path, body);
      setStatus(statusOf(answer, T.unavailable, "/account"));
      if (answer.ok && answer.body) done(answer.body);
    });

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send("/api/account/keys", {}, ({ key, apiKey }) => {
      if (typeof key === "string") setShown(key);
      if (apiKey) setList((l) => [...l, apiKey]);
    });
  }
  const revoke = (keyId: string) => send("/api/account/keys/revoke", { keyId }, () => setList((l) => l.filter((k) => k.id !== keyId)));

  return (
    <section data-testid="api-keys" {...section}>
      <h2 ref={heading} tabIndex={-1} className="mt-10 text-xl font-semibold">
        {T.heading}
      </h2>
      <p className="mt-2 break-words">{T.intro}</p>
      <form method="post" action="/api/account/keys" onSubmit={create} className="mt-3">
        <button type="submit" {...buttonState(hydrated, busy !== null)} className="rounded px-4 py-2 font-medium" style={accent}>
          {busy === "/api/account/keys" ? T.busy : T.create}
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
              <ConfirmButton label={T.revoke} question={T.revokeQuestion(k.hint)} confirm={T.revokeConfirm} cancel={T.revokeCancel} name={(label) => T.buttonName(label, T.item(k.hint, k.createdOn))} hydrated={hydrated} busy={busy !== null} onConfirm={() => void revoke(k.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
