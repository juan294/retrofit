import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { ConfirmSignInForm } from "@/components/ConfirmSignInForm";
import { SitePage } from "@/components/SitePage";
import { confirmPageState } from "@/lib/api/confirm";
import { SIGN_IN_COOKIE } from "@/lib/api/sign-in";
import { SIGN_IN_TEXT as T } from "@/lib/site/sign-in-texts";

export const metadata: Metadata = { title: "Sign in · Retrofit", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * GET /auth/confirm?token_hash=<hash>&type=email: the page the emailed link opens. It verifies
 * nothing and sets no cookie (mail scanners open links); the visitor's "Sign in" posts the token
 * to /auth/verify. Responses are no-store (src/proxy.ts) with Referrer-Policy no-referrer
 * (src/lib/security/headers.ts), so the token never leaves in a Referer.
 */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = confirmPageState(await searchParams, (await cookies()).has(SIGN_IN_COOKIE));
  return (
    <SitePage title={T.confirmTitle}>
      {state.kind === "confirm" ? (
        <>
          <p className="mt-4">{T.confirmIntro}</p>
          <ConfirmSignInForm tokenHash={state.tokenHash} otherBrowser={state.otherBrowser} />
        </>
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
