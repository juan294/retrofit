import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { ConfirmAddressForm, ConfirmSignInForm } from "@/components/ConfirmSignInForm";
import { SitePage } from "@/components/SitePage";
import { confirmPageState } from "@/lib/api/confirm";
import { pendingCookieName, pendingSignIn } from "@/lib/api/sign-in";
import { getServerDeps } from "@/lib/server/runtime";
import { SIGN_IN_TEXT as T } from "@/lib/site/sign-in-texts";

export const metadata: Metadata = { title: "Sign in · Retrofit", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** The sign-in that waits for this browser's Continue; null when there is none or the Store cannot be read. */
async function waitingSignIn(): Promise<{ email: string; ref: string } | null> {
  const deps = getServerDeps();
  try {
    return await pendingSignIn(deps.store, (await cookies()).get(pendingCookieName(deps.config))?.value);
  } catch (e) {
    console.error("GET /auth/confirm failed:", e instanceof Error ? e.name : "unknown error");
    return null;
  }
}

/**
 * GET /auth/confirm?token_hash=<hash>&type=email: the page the emailed link opens. It verifies
 * nothing and sets no cookie (mail scanners open links); the visitor's "Sign in" posts the token
 * to /auth/verify. ?step=address: the verified address of a link this browser did not ask for, with
 * "Continue". Responses are no-store (src/proxy.ts) with Referrer-Policy no-referrer
 * (src/lib/security/headers.ts), so the token never leaves in a Referer.
 */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = confirmPageState(await searchParams);
  const waiting = state.kind === "address" ? await waitingSignIn() : null;
  return (
    <SitePage title={T.confirmTitle}>
      {state.kind === "confirm" ? (
        <>
          <p className="mt-4">{T.confirmIntro}</p>
          <ConfirmSignInForm tokenHash={state.tokenHash} />
        </>
      ) : waiting ? (
        <ConfirmAddressForm email={waiting.email} pending={waiting.ref} />
      ) : (
        <>
          <p className="mt-4" role="alert">
            {T.confirmInvalid}
          </p>
          <p className="mt-4">
            <Link href="/sign-in" className="underline">
              {T.newLink}
            </Link>
          </p>
        </>
      )}
    </SitePage>
  );
}
