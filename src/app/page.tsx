import { headers } from "next/headers";
import Link from "next/link";
import { connection } from "next/server";
import { getConfig } from "@/lib/config";
import { LEAD_EMAIL, leadMailto, retrofitJsonLd } from "@/lib/site/own-site";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteNav } from "@/components/SiteNav";
import { UrlForm } from "@/components/UrlForm";
import { AgentPanel } from "@/components/preview/AgentPanel";

export default async function Home() {
  // Render per request so that each response carries its own CSP nonce.
  await connection();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  // JSON-LD is data, not script; "<" is escaped so no value can close the element.
  const jsonLd = JSON.stringify(retrofitJsonLd(getConfig().publicOrigin)).replace(/</g, "\\u003c");
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      {/* eslint-disable-next-line react/no-danger -- JSON-LD is a data block built from constants with "<" escaped; React would entity-encode it as text */}
      <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <SiteNav />
      <h1 className="mt-8 text-4xl font-semibold">Retrofit</h1>
      <p className="mt-4 text-lg" style={{ color: "var(--color-muted)" }}>
        An agent on your own website that can take the order, and it is yours to keep.
      </p>
      <UrlForm />
      <p className="mt-4 text-sm">
        We can also set it up for you: <a className="underline [overflow-wrap:anywhere]" href={leadMailto()}>{LEAD_EMAIL}</a>
      </p>
      <p className="mt-6 text-sm" style={{ color: "var(--color-muted)" }}>
        Retrofit reads your public pages, your robots.txt, sitemap, llms.txt and agent manifest. It skips sign-in, account and checkout
        pages and follows your robots rules. <Link href="/bot" className="underline">How RetrofitBot reads your site</Link>.
      </p>
      <AgentPanel basePath="" title="Ask Retrofit's own agent" />
      <div className="mt-16">
        <SiteFooter />
      </div>
    </main>
  );
}
