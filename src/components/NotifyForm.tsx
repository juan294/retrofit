"use client";

import { useState, type FormEvent } from "react";
import { NOTIFY_FORM_TEXT as T, REQUEST_TEXT } from "@/lib/site/pricing-texts";
import { postJson, statusOf, type Status } from "./post";
import { StatusMessage } from "./StatusMessage";
import { useHydrated } from "./useHydrated";
import { buttonState, useOneAtATime } from "./useOneAtATime";

/**
 * "Notify me": an email field, an unticked product-news box and the privacy link.
 * Without a privacy link the form is not shown (the plan refuses it then).
 * Before hydration the button is disabled (so is implicit submission with Enter), and the form is
 * a POST to the API, so the address can never reach a page URL.
 */
export function NotifyForm({ privacyHref }: { privacyHref: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const { busy, run } = useOneAtATime();
  const hydrated = useHydrated();
  if (!privacyHref) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    if (!email) {
      setStatus({ ok: false, text: T.emptyEmail });
      return;
    }
    void run("send", async () => {
      setStatus(null);
      const answer = await postJson("/api/notify", { email, consent: data.get("consent") === "yes" });
      setStatus(statusOf(answer, REQUEST_TEXT.unavailable, "/pricing"));
      if (answer.ok) form.reset();
    });
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
          {...buttonState(hydrated, busy !== null)}
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
      <StatusMessage status={status} id="notify-status" />
    </form>
  );
}
