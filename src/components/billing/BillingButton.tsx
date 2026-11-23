"use client";

import { useState, type FormEvent } from "react";
import { BILLING_TEXT as T } from "@/lib/site/billing-texts";
import { useHydrated } from "../useHydrated";
import { billingStep, type BillingStep } from "./answer";

/**
 * One billing action (an upgrade, Manage billing): posts to Retrofit and then navigates to the hosted
 * page the answer names, with location.assign, so no form is ever posted to another origin. Disabled
 * until hydration and while it works. `returnTo`: where sign-in returns a signed-out visitor.
 * `fixtureOrigin`: fixtures mode only (urls.ts).
 */
export function BillingButton({ path, body = {}, label, returnTo, fixtureOrigin, primary = true }: { path: string; body?: Record<string, string>; label: string; returnTo: string; fixtureOrigin: string | null; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Exclude<BillingStep, { go: string }> | null>(null);
  const hydrated = useHydrated();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    let step: BillingStep;
    try {
      const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      step = billingStep(res.status, await res.json().catch(() => null), fixtureOrigin, returnTo);
    } catch {
      step = { text: T.unavailable };
    }
    if ("go" in step) {
      // Stays busy: the page is leaving.
      window.location.assign(step.go);
      return;
    }
    setNotice(step);
    setBusy(false);
  }

  return (
    <form method="post" action={path} onSubmit={submit} className="mt-3 flex flex-col items-start gap-2">
      <button
        type="submit"
        disabled={busy || !hydrated}
        className={primary ? "rounded px-4 py-2 font-medium" : "rounded border px-4 py-2"}
        style={primary ? { background: "var(--color-accent)", color: "var(--color-accent-text)" } : { borderColor: "var(--color-border)" }}
      >
        {busy ? T.busy : label}
      </button>
      {notice ? (
        <p role="alert" data-testid="billing-message" style={{ color: "var(--color-danger)" }}>
          {notice.text}
          {notice.href ? (
            <>
              {" "}
              <a href={notice.href} className="underline">
                {notice.linkText}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}
