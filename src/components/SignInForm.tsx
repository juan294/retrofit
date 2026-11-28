"use client";

import { useState, type FormEvent } from "react";
import { SIGN_IN_TEXT as T } from "@/lib/site/sign-in-texts";
import { postJson, statusOf, type Status } from "./post";
import { StatusMessage } from "./StatusMessage";
import { useHydrated } from "./useHydrated";
import { buttonState, useOneAtATime } from "./useOneAtATime";

/**
 * The sign-in form: one email field. It posts JSON to /api/auth/sign-in and then offers
 * "Send the link again". Before hydration the button is disabled (so is implicit submission
 * with Enter), and the form is a POST to the API, so the address can never reach a page URL.
 */
export function SignInForm({ returnTo, privacyHref }: { returnTo: string; privacyHref: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const { busy, run } = useOneAtATime();
  const [sent, setSent] = useState(false);
  const hydrated = useHydrated();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    if (!email) {
      setStatus({ ok: false, text: T.emptyEmail });
      return;
    }
    void run("send", async () => {
      setStatus(null);
      const answer = await postJson("/api/auth/sign-in", { email, returnTo });
      setStatus(statusOf(answer, T.unavailable, returnTo));
      if (answer.ok) setSent(true);
    });
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
          {...buttonState(hydrated, busy !== null)}
          className="rounded px-4 py-2 font-medium"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
        >
          {busy ? T.busy : sent ? T.sendAgain : T.submit}
        </button>
      </div>
      <p>{T.sameBrowser}</p>
      <p className="text-sm" style={{ color: "var(--color-muted)" }}>
        {T.privacyBefore}
        <a href={privacyHref} className="underline">
          {T.privacyLink}
        </a>
        {T.privacyAfter}
      </p>
      <StatusMessage status={status} id="sign-in-status" />
    </form>
  );
}
