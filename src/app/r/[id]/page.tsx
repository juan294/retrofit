import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { AnalysisView } from "@/components/analysis/AnalysisView";
import { getAnalysis, isAnalysisId } from "@/lib/analysis/record";
import { VISITOR_COOKIE, hashVisitor, sameHash } from "@/lib/analysis/visitor";
import { getServerDeps } from "@/lib/server/runtime";

export const metadata: Metadata = { title: "Your analysis · Retrofit", robots: { index: false, follow: false } };

export default async function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = (await cookies()).get(VISITOR_COOKIE)?.value;
  if (!token || !isAnalysisId(id)) notFound();
  const analysis = await getAnalysis(getServerDeps().store, id);
  // Same page for another visitor's analysis and for an id that does not exist.
  if (!analysis || !sameHash(analysis.ownerHash, hashVisitor(token))) notFound();
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
      <AnalysisView id={id} inputOrigin={analysis.inputOrigin} />
    </main>
  );
}
