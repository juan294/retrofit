"use client";

import { useState } from "react";
import { SIGN_IN_TEXT as T } from "@/lib/site/sign-in-texts";
import { useHydrated } from "./useHydrated";


/**
 * The "Sign in" button on /auth/confirm: a POST of the link's token to /auth/verify, which alone
 * verifies it. Opening the emailed link (or a mail scanner opening it) changes nothing. The button
 * stays disabled until hydration, like every Retrofit form.
 */
export function ConfirmSignInForm({ tokenHash, otherBrowser }: { tokenHash: string; otherBrowser: boolean }) {
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  return (
    <form method="post" action="/auth/verify" onSubmit={() => setBusy(true)} className="mt-6 flex flex-col items-start gap-4">
      {otherBrowser ? (
        <p role="alert" data-testid="other-browser" style={{ color: "var(--color-danger)" }}>
          {T.otherBrowser}
        </p>
      ) : null}
      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value="email" />
      <button type="submit" disabled={busy || !hydrated} className="rounded px-4 py-2 font-medium" style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}>
        {busy ? T.confirmBusy : T.confirmButton}
      </button>
    </form>
  );
}
