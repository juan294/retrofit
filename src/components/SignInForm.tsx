"use client";

import { useState, type FormEvent } from "react";
import { SIGN_IN_TEXT as T } from "@/lib/site/sign-in-texts";
import { localizeRetry } from "./analysis/retry-time";
import { useHydrated } from "./useHydrated";

type Status = { readonly ok: boolean; readonly text: string } | null;


/**
 * The sign-in form: one email field. It posts JSON to /api/auth/sign-in and then offers
 * "Send the link again". Before hydration the button is disabled (so is implicit submission
 * with Enter), and the form is a POST to the API, so the address can never reach a page URL.
 */
export function SignInForm({ returnTo, privacyHref }: { returnTo: string; privacyHref: string }) {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const hydrated = useHydrated();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    if (!email) {
      setStatus({ ok: false, text: T.emptyEmail });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/auth/sign-in", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, returnTo }),
      });
      const body = (await res.json().catch(() => null)) as { message?: unknown; retryAt?: unknown } | null;
      const message = typeof body?.message === "string" ? body.message : T.unavailable;
      const retryAt = typeof body?.retryAt === "string" ? body.retryAt : undefined;
      setStatus({ ok: res.ok, text: res.ok ? message : localizeRetry(message, retryAt) });
      if (res.ok) setSent(true);
    } catch {
      setStatus({ ok: false, text: T.unavailable });
    }
    setBusy(false);
  }

  return (
    <form method="post" action="/api/auth/sign-in" onSubmit={submit} className="mt-6 flex flex-col gap-3" noValidate>
      <label htmlFor="sign-in-email" className="font-medium">
        {T.emailLabel}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="sign-in-email"
          name="email"
          type="email"
          autoComplete="email"
          className="min-w-0 flex-1 rounded border px-3 py-2"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
          aria-describedby={status ? "sign-in-status" : undefined}
        />
        <button
          type="submit"
          disabled={busy || !hydrated}
          className="rounded px-4 py-2 font-medium"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
        >
          {busy ? T.busy : sent ? T.sendAgain : T.submit}
        </button>
      </div>
      <p className="text-sm" style={{ color: "var(--color-muted)" }}>
        {T.privacyBefore}
        <a href={privacyHref} className="underline">
          {T.privacyLink}
        </a>
        {T.privacyAfter}
      </p>
      {status ? (
        <p id="sign-in-status" role={status.ok ? "status" : "alert"} style={status.ok ? undefined : { color: "var(--color-danger)" }}>
          {status.text}
        </p>
      ) : null}
    </form>
  );
}
