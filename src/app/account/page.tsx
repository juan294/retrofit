import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ClaimsSection } from "@/components/claims/ClaimsSection";
import { SitePage } from "@/components/SitePage";
import type { SavedReportSummary } from "@/lib/accounts/data";
import { claimOptions, type ClaimOption } from "@/lib/claims/sources";
import { claimView, type ClaimView } from "@/lib/claims/view";
import { signInHref } from "@/lib/accounts/return-to";
import { ACCOUNT_COOKIE, readAccountByToken, type Account } from "@/lib/accounts/session";
import { getServerDeps } from "@/lib/server/runtime";
import { ACCOUNT_TEXT as T, dateText } from "@/lib/site/account-texts";

export const metadata: Metadata = { title: "Your account · Retrofit", robots: { index: false, follow: false } };

const DELETE_NOTICES = { confirm: T.deleteNeedsConfirm, failed: T.deleteFailed, partial: T.deletePartial } as const;

const buttonStyle = { background: "var(--color-accent)", color: "var(--color-accent-text)" };
const borderStyle = { borderColor: "var(--color-border)" };

/** /account[?delete=confirm|failed|partial]: the signed-in account. Signed out -> /sign-in?returnTo=/account. */
export default async function AccountPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { delete: deleteState } = await searchParams;
  const deps = getServerDeps();
  let account: Account | null = null;
  let reports: SavedReportSummary[] | null = null;
  let claims: ClaimView[] = [];
  let options: ClaimOption[] = [];
  try {
    account = await readAccountByToken((await cookies()).get(ACCOUNT_COOKIE)?.value, deps);
    if (account) {
      const [saved, held] = await Promise.all([deps.accounts.listSavedReports(account.accountId), deps.accounts.listClaims(account.accountId)]);
      reports = saved;
      claims = held.map((c) => claimView(c, deps.config));
      options = await claimOptions(deps, account.accountId, saved, held);
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

      <h2 className="mt-10 text-xl font-semibold">{T.reportsHeading}</h2>
      {reports.length === 0 ? (
        <p className="mt-2">{T.noReports}</p>
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
