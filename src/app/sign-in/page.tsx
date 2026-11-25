import type { Metadata } from "next";
import { SignInForm } from "@/components/SignInForm";
import { SitePage } from "@/components/SitePage";
import { safeReturnTo } from "@/lib/accounts/return-to";
import { SIGN_IN_TEXT as T } from "@/lib/site/sign-in-texts";

export const metadata: Metadata = { title: "Sign in · Retrofit", robots: { index: false, follow: false } };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/**
 * /sign-in[?returnTo=<path>][&link=expired|unavailable|busy][&account=deleted]: the email form. The
 * confirm route sends expired, used and malformed links here with `link=expired` ("This link has
 * expired" and the send-again form, prefilled with nothing).
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const link = one(params.link);
  const expired = link === "expired";
  return (
    <SitePage title={expired ? T.expiredTitle : T.title}>
      {one(params.account) === "deleted" ? (
        <p className="mt-4" role="status">
          {T.deleted}
        </p>
      ) : null}
      {link === "unavailable" ? (
        <p className="mt-4" role="alert" style={{ color: "var(--color-danger)" }}>
          {T.linkUnavailable}
        </p>
      ) : null}
      {link === "busy" ? (
        <p className="mt-4" role="alert" style={{ color: "var(--color-danger)" }}>
          {T.linkBusy}
        </p>
      ) : null}
      <p className="mt-4">{expired ? T.expired : T.intro}</p>
      <SignInForm returnTo={safeReturnTo(one(params.returnTo))} privacyHref="/privacy" />
    </SitePage>
  );
}
