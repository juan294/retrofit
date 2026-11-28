import type { Metadata } from "next";
import { SitePage } from "@/components/SitePage";
import { SCORE_ENDPOINT_TEXT } from "@/lib/analysis/texts";

export const metadata: Metadata = { title: "RetrofitBot · Retrofit" };

export default function BotPage() {
  return (
    <SitePage title="RetrofitBot">
      <p className="mt-4">
        RetrofitBot reads a public website when someone asks Retrofit to score it. It identifies itself with the user agent{" "}
        <code>RetrofitBot/0.1</code> and a link to this page.
      </p>
      <h2 className="mt-8 text-xl font-semibold">What it reads</h2>
      <ul className="mt-2 list-disc pl-6">
        <li>robots.txt, before anything else, on every host it contacts.</li>
        <li>The home page and at most 11 more pages linked from it on the same host.</li>
        <li>/agent-manifest.json, /llms.txt and /sitemap.xml, and the agent network file your manifest declares, which can be on another host.</li>
        <li>It never reads sign-in, account, cart, checkout or administration pages, and never submits a form.</li>
      </ul>
      <h2 className="mt-8 text-xl font-semibold">Its limits</h2>
      <ul className="mt-2 list-disc pl-6">
        <li>At most one request per second to a host, or your full Crawl-delay if it is longer. When the next request would not fit in the time limit of one crawl, it stops instead of waiting less.</li>
        <li>At most 2 MB per page, 8 seconds per request and 45 seconds per site.</li>
        <li>Results are usually kept for up to 24 hours; a site's verified owner can ask for a new read one hour after the last one. It sends no cookies and keeps no email addresses.</li>
        <li>It reads only public addresses on ports 80 and 443.</li>
      </ul>
      <h2 className="mt-8 text-xl font-semibold">How to block it</h2>
      <p className="mt-2">Add these lines to your robots.txt. RetrofitBot then stops and reads nothing else from your site.</p>
      <pre className="mt-2 rounded border p-3" style={{ borderColor: "var(--color-border)" }}>
        {"User-agent: RetrofitBot\nDisallow: /"}
      </pre>
      <h2 className="mt-8 text-xl font-semibold">For agents</h2>
      <p className="mt-2" id="score-api">
        {SCORE_ENDPOINT_TEXT}
      </p>
    </SitePage>
  );
}
