import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ScoreReport, storedReportView } from "@/components/analysis/ScoreReport";
import { isUuid } from "@/lib/accounts/data";
import { signInHref } from "@/lib/accounts/return-to";
import { accountCookieName, readAccountByToken } from "@/lib/accounts/session";
import { getServerDeps } from "@/lib/server/runtime";
import { SAVED_REPORT_TEXT as T, dateText } from "@/lib/site/account-texts";

export const metadata: Metadata = { title: "Saved report · Retrofit", robots: { index: false, follow: false } };

/**
 * /account/reports/<id>: a saved report, read-only (no agent preview, no install files). Signed out
 * -> sign-in, returning here. Another account's report and an unknown id get the same 404.
 */
export default async function SavedReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const deps = getServerDeps();
  const account = await readAccountByToken((await cookies()).get(accountCookieName(deps.config))?.value, deps);
  if (!account) redirect(signInHref(`/account/reports/${id}`));
  const saved = await deps.accounts.getSavedReport(account.accountId, id);
  if (!saved) notFound();
  return (
    <main className="mx-auto max-w-3xl px-4 py-12 [overflow-wrap:anywhere]">
      <p>
        <Link href="/" className="underline">
          Retrofit
        </Link>{" "}
        ·{" "}
        <Link href="/account" className="underline">
          {T.back}
        </Link>
      </p>
      <h1 className="mt-4 text-3xl font-semibold">{T.title(saved.host)}</h1>
      <p className="mt-2" style={{ color: "var(--color-muted)" }}>
        {T.notice(dateText(saved.savedAt))}
      </p>
      <ScoreReport report={storedReportView(saved.report)} readOn={dateText(saved.fetchedAt)} />
    </main>
  );
}
