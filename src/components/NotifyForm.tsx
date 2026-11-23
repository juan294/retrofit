"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import { NOTIFY_FORM_TEXT as T, REQUEST_TEXT } from "@/lib/site/pricing-texts";
import { localizeRetry } from "./analysis/retry-time";

type Status = { readonly ok: boolean; readonly text: string } | null;

const noSubscription = () => () => {};

/** False in the server HTML and until hydration, true after it. */
function useHydrated(): boolean {
  return useSyncExternalStore(noSubscription, () => true, () => false);
}

/**
 * "Notify me": an email field, an unticked product-news box and the privacy link.
 * Without a privacy link the form is not shown (the plan refuses it then).
 * Before hydration the button is disabled (so is implicit submission with Enter), and the form is
 * a POST to the API, so the address can never reach a page URL.
 */
export function NotifyForm({ privacyHref }: { privacyHref: string }) {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();
  if (!privacyHref) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    if (!email) {
      setStatus({ ok: false, text: T.emptyEmail });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/notify", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, consent: data.get("consent") === "yes" }),
      });
      const body = (await res.json().catch(() => null)) as { message?: unknown; retryAt?: unknown } | null;
      const message = typeof body?.message === "string" ? body.message : REQUEST_TEXT.unavailable;
      const retryAt = typeof body?.retryAt === "string" ? body.retryAt : undefined;
      setStatus({ ok: res.ok, text: res.ok ? message : localizeRetry(message, retryAt) });
      if (res.ok) form.reset();
    } catch {
      setStatus({ ok: false, text: REQUEST_TEXT.unavailable });
    }
    setBusy(false);
  }

  return (
    <form method="post" action="/api/notify" onSubmit={submit} className="mt-4 flex flex-col gap-3" noValidate>
      <label htmlFor="notify-email" className="font-medium">
        {T.emailLabel}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="notify-email"
          name="email"
          type="email"
          autoComplete="email"
          className="min-w-0 flex-1 rounded border px-3 py-2"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
          aria-describedby={status ? "notify-status" : undefined}
        />
        <button
          type="submit"
          disabled={busy || !hydrated}
          className="rounded px-4 py-2 font-medium"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
        >
          {busy ? T.busy : T.submit}
        </button>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" name="consent" value="yes" />
        {T.consentLabel}
      </label>
      <p className="text-sm" style={{ color: "var(--color-muted)" }}>
        {T.privacyBefore}
        <a href={privacyHref} className="underline">
          {T.privacyLink}
        </a>
        {T.privacyAfter}
      </p>
      {status ? (
        <p id="notify-status" role={status.ok ? "status" : "alert"} style={status.ok ? undefined : { color: "var(--color-danger)" }}>
          {status.text}
        </p>
      ) : null}
    </form>
  );
}
