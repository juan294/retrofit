"use client";

import { useState, type ReactNode } from "react";
import { SIGN_IN_TEXT as T } from "@/lib/site/sign-in-texts";
import { useHydrated } from "./useHydrated";

/** A POST to /auth/verify with one button, disabled until hydration, like every Retrofit form. */
function VerifyForm({ label, busyLabel, secondary, children }: { label: string; busyLabel: string; secondary?: boolean; children: ReactNode }) {
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  return (
    <form method="post" action="/auth/verify" onSubmit={() => setBusy(true)} className="mt-6 flex flex-col items-start gap-4">
      {children}
      <button type="submit" disabled={busy || !hydrated} className={secondary ? "underline" : "rounded px-4 py-2 font-medium"} style={secondary ? undefined : { background: "var(--color-accent)", color: "var(--color-accent-text)" }}>
        {busy ? busyLabel : label}
      </button>
    </form>
  );
}

/**
 * The "Sign in" button on /auth/confirm: posts the link's token to /auth/verify, which alone verifies
 * it. Opening the emailed link (or a mail scanner opening it) changes nothing.
 */
export function ConfirmSignInForm({ tokenHash }: { tokenHash: string }) {
  return (
    <VerifyForm label={T.confirmButton} busyLabel={T.confirmBusy}>
      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value="email" />
    </VerifyForm>
  );
}

/** The address step: the link was verified, and it signs in to `email`. Nothing is signed in until Continue, which takes only the sign-in shown (`pending`). */
export function ConfirmAddressForm({ email, pending }: { email: string; pending: string }) {
  return (
    <>
      <p className="mt-4">{T.addressIntro}</p>
      <p className="mt-2 font-semibold" data-testid="confirm-address">
        {email}
      </p>
      <p className="mt-4" role="alert" data-testid="other-browser" style={{ color: "var(--color-danger)" }}>
        {T.otherBrowser}
      </p>
      <VerifyForm label={T.continueButton} busyLabel={T.confirmBusy}>
        <input type="hidden" name="continue" value="yes" />
        <input type="hidden" name="pending" value={pending} />
      </VerifyForm>
      <VerifyForm label={T.cancel} busyLabel={T.cancel} secondary>
        <input type="hidden" name="cancel" value="yes" />
        <input type="hidden" name="pending" value={pending} />
      </VerifyForm>
    </>
  );
}
