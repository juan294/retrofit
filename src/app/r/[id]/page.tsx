import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { AnalysisView } from "@/components/analysis/AnalysisView";
import { ACCOUNT_COOKIE } from "@/lib/accounts/session";
import { resultsPageAccess } from "@/lib/analysis/owner";
import { VISITOR_COOKIE } from "@/lib/analysis/visitor";
import { getServerDeps } from "@/lib/server/runtime";

export const metadata: Metadata = { title: "Your analysis · Retrofit", robots: { index: false, follow: false } };

export default async function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jar = await cookies();
  const who = { visitorToken: jar.get(VISITOR_COOKIE)?.value ?? null, accountToken: jar.get(ACCOUNT_COOKIE)?.value ?? null };
  // Same page for another visitor's or account's analysis and for an id that does not exist.
  const access = await resultsPageAccess(id, who, getServerDeps());
  if (!access) notFound();
  const { analysis, signedIn } = access;
  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <p>
        <a href="/" className="underline">
          Retrofit
        </a>
      </p>
      <h1 className="mt-4 text-3xl font-semibold">Agent readiness</h1>
      <p className="mt-2" style={{ color: "var(--color-muted)" }}>
        {analysis.inputOrigin}
      </p>
      <AnalysisView id={id} inputOrigin={analysis.inputOrigin} canSave={signedIn} />
    </main>
  );
}
