"use client";

import { useState, type FormEvent } from "react";
import { BILLING_TEXT as T } from "@/lib/site/billing-texts";
import { postJson } from "../post";
import { StatusMessage } from "../StatusMessage";
import { useHydrated } from "../useHydrated";
import { buttonState, useOneAtATime } from "../useOneAtATime";
import { billingStep, type BillingStep } from "./answer";

/**
 * One billing action (an upgrade, Manage billing): posts to Retrofit and then navigates to the hosted
 * page the answer names, with location.assign, so no form is ever posted to another origin. Disabled
 * until hydration; while it works another press does nothing. `returnTo`: where sign-in returns a signed-out visitor.
 * `fixtureOrigin`: fixtures mode only (urls.ts).
 */
export function BillingButton({ path, body = {}, label, returnTo, fixtureOrigin, primary = true }: { path: string; body?: Record<string, string>; label: string; returnTo: string; fixtureOrigin: string | null; primary?: boolean }) {
  const { busy, run } = useOneAtATime();
  const [notice, setNotice] = useState<Exclude<BillingStep, { go: string }> | null>(null);
  const hydrated = useHydrated();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(path, async () => {
      setNotice(null);
      const answer = await postJson(path, body);
      const step = billingStep(answer.status, answer.body, fixtureOrigin, returnTo);
      if ("go" in step) {
        window.location.assign(step.go);
        return "leaving";
      }
      setNotice(step);
    });
  }

  return (
    <form method="post" action={path} onSubmit={submit} className="mt-3 flex flex-col items-start gap-2">
      <button
        type="submit"
        {...buttonState(hydrated, busy !== null)}
        className={primary ? "rounded px-4 py-2 font-medium" : "rounded border px-4 py-2"}
        style={primary ? { background: "var(--color-accent)", color: "var(--color-accent-text)" } : { borderColor: "var(--color-border)" }}
      >
        {busy ? T.busy : label}
      </button>
      <StatusMessage status={notice && { ...notice, ok: false }} testId="billing-message" />
    </form>
  );
}
