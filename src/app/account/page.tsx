import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ApiKeysSection } from "@/components/billing/ApiKeysSection";
import { BillingSection } from "@/components/billing/BillingSection";
import { ClaimsSection } from "@/components/claims/ClaimsSection";
import { SitePage } from "@/components/SitePage";
import type { SavedReportSummary } from "@/lib/accounts/data";
import { apiKeyView, type ApiKeyView } from "@/lib/api/api-keys";
import { fixtureOriginOf } from "@/lib/billing/checkout";
import { billingStarted } from "@/lib/billing/entitlements";
import { accountBilling } from "@/lib/billing/reconcile";
import { logBillingFailure } from "@/lib/billing/sync";
import { billingView, type BillingView } from "@/lib/billing/view";
import { listAccountAnalyses } from "@/lib/analysis/account-list";
import { CLAIM_RECENT_ANALYSES, claimOptions, type ClaimOption } from "@/lib/claims/sources";
import { accountClaimViews, type AccountClaimView } from "@/lib/claims/view";
import { signInHref } from "@/lib/accounts/return-to";
import { accountCookieName, readAccountByToken, type Account } from "@/lib/accounts/session";
import { getServerDeps } from "@/lib/server/runtime";
import { ACCOUNT_TEXT as T, dateText } from "@/lib/site/account-texts";

export const metadata: Metadata = { title: "Your account · Retrofit", robots: { index: false, follow: false } };

const DELETE_NOTICES = { confirm: T.deleteNeedsConfirm, failed: T.deleteFailed, subscription: T.deleteSubscriptionKept, partial: T.deletePartial, cancelled: T.deleteFailedCancelled, "partial-cancelled": T.deletePartialCancelled } as const;

const buttonStyle = { background: "var(--color-accent)", color: "var(--color-accent-text)" };
const borderStyle = { borderColor: "var(--color-border)" };

/**
 * /account[?delete=confirm|failed|subscription|partial|cancelled|partial-cancelled][&checkout=success]: the signed-in account.
 * Signed out -> /sign-in?returnTo=/account. From BILLING_START on it shows the plan, read again from
 * Stripe when it is old or the visitor returns from checkout (accountBilling, bounded in time).
 */
export default async function AccountPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { delete: deleteState, checkout } = await searchParams;
  const deps = getServerDeps();
  let account: Account | null = null;
  let reports: SavedReportSummary[] | null = null;
  let claims: AccountClaimView[] = [];
  let options: ClaimOption[] = [];
  let keys: ApiKeyView[] = [];
  // Undefined before BILLING_START; null when the plan could not be read.
  let billing: BillingView | null | undefined;
  try {
    account = await readAccountByToken((await cookies()).get(accountCookieName(deps.config))?.value, deps);
    if (account) {
      const [saved, held, published, analyses, apiKeys, plan] = await Promise.all([
        deps.accounts.listSavedReports(account.accountId),
        deps.accounts.listClaims(account.accountId),
        deps.accounts.listPublishedSites(account.accountId),
        listAccountAnalyses(deps, account.accountId, CLAIM_RECENT_ANALYSES),
        deps.accounts.listApiKeys(account.accountId),
        billingStarted(deps)
          ? accountBilling(deps, account.accountId, { checkout: checkout === "success" }).then((b) => billingView(b, deps.clock()), (e: unknown) => {
              logBillingFailure("GET /account billing", e);
              return null;
            })
          : undefined,
      ]);
      keys = apiKeys.map(apiKeyView);
      billing = plan;
      reports = saved;
      claims = accountClaimViews(held, published, deps.config);
      options = claimOptions(analyses, saved, held);
    }
  } catch (e) {
    console.error("GET /account failed:", e instanceof Error ? e.name : "unknown error");
    return (
      <SitePage title={T.title}>
        <p className="mt-4" role="alert">
          {T.unavailable}
        </p>
      </SitePage>
    );
  }
  if (!account || !reports) redirect(signInHref("/account"));
  const notice = typeof deleteState === "string" && Object.hasOwn(DELETE_NOTICES, deleteState) ? DELETE_NOTICES[deleteState as keyof typeof DELETE_NOTICES] : null;

  return (
    <SitePage title={T.title}>
      {notice ? (
        <p className="mt-4" role="alert" style={{ color: "var(--color-danger)" }}>
          {notice}
        </p>
      ) : null}
      <p className="mt-4">
        {T.signedInAs} <strong data-testid="account-email">{account.email}</strong>
      </p>
      <form method="post" action="/api/auth/sign-out" className="mt-4">
        <button type="submit" className="rounded border px-4 py-2" style={borderStyle}>
          {T.signOut}
        </button>
      </form>

      {billing === undefined ? null : <BillingSection view={billing} fixtureOrigin={fixtureOriginOf(deps.config)} />}

      <h2 className="mt-10 text-xl font-semibold">{T.reportsHeading}</h2>
      {reports.length === 0 ? (
        <p className="mt-2">
          {T.noReports}{" "}
          <a href="/" className="underline">
            {T.analyze}
          </a>
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2" data-testid="saved-reports">
          {reports.map((r) => (
            <li key={r.id} className="rounded border p-3" style={borderStyle}>
              <Link href={`/account/reports/${r.id}`} className="font-medium underline">
                {r.host}
              </Link>{" "}
              <span>{T.score(r.score)}</span>{" "}
              <span className="text-sm" style={{ color: "var(--color-muted)" }}>
                ({T.readOn} {dateText(r.fetchedAt)})
              </span>
            </li>
          ))}
        </ul>
      )}

      <ClaimsSection claims={claims} options={options} />

      <ApiKeysSection keys={keys} />

      <h2 className="mt-10 text-xl font-semibold">{T.deleteHeading}</h2>
      <p className="mt-2">{T.deleteIntro}</p>
      <form method="post" action="/api/account/delete" className="mt-4 flex flex-col items-start gap-3">
        <label className="flex items-start gap-2">
          <input type="checkbox" name="confirm" value="yes" required className="mt-1" />
          <span>{T.deleteConfirm}</span>
        </label>
        <button type="submit" className="rounded px-4 py-2 font-medium" style={buttonStyle}>
          {T.deleteButton}
        </button>
      </form>
    </SitePage>
  );
}
