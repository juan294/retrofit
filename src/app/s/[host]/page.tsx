import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ScoreReport, storedReportView } from "@/components/analysis/ScoreReport";
import { SiteNav } from "@/components/SiteNav";
import { PublishedAgent } from "@/components/publish/PublishedAgent";
import { readPublishedPage } from "@/lib/publish/page";
import { publishedUrl } from "@/lib/publish/url";
import { getServerDeps } from "@/lib/server/runtime";
import { dateText } from "@/lib/site/account-texts";
import { PUBLISHED_PAGE_TEXT as T } from "@/lib/site/publish-texts";

export const dynamic = "force-dynamic";

/** The metadata and the page share one read per request. An outage throws, so the page answers an error, never a 404. */
const load = cache((rawHost: string) => readPublishedPage(getServerDeps(), rawHost));

type Props = { params: Promise<{ host: string }> };

/** Indexable (no robots rule) while it is public; the 404 below adds noindex, and so does an outage (the page then throws). */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const site = await load((await params).host).catch(() => "unavailable" as const);
  if (site === "unavailable") return { title: `${T.unavailableTitle} · Retrofit`, robots: { index: false } };
  if (!site) return { title: `${T.notFoundTitle} · Retrofit` };
  return { title: T.metaTitle(site.host), description: T.metaDescription(site.host), alternates: { canonical: publishedUrl(getServerDeps().config.publicOrigin, site.host) } };
}

/** /s/<host>: the public report and agent of a site its verified owner published. 404 for any host that is not public now, or not in its exact form. */
export default async function PublishedPage({ params }: Props) {
  const site = await load((await params).host);
  if (!site) notFound();
  const saved = dateText(site.fetchedAt);
  return (
    <main className="mx-auto max-w-3xl px-4 py-12 [overflow-wrap:anywhere]">
      <SiteNav />
      <h1 className="mt-4 text-3xl font-semibold">{T.title(site.host)}</h1>
      <p className="mt-2" data-testid="published-by">
        {T.publishedBy(site.host, saved)}
      </p>
      <ScoreReport report={storedReportView(site.report)} readOn={saved}>
        <PublishedAgent key={site.host} host={site.host} />
      </ScoreReport>
    </main>
  );
}
