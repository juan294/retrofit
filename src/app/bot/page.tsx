import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "RetrofitBot · Retrofit" };

const ENDPOINT_DESCRIPTION =
  "GET https://retrofit.thecreativetoken.com/api/score?url=<public website address> returns Retrofit's agent-readiness score (score/v1, 0 to 100) for a public website, read from its home page and up to 11 more linked pages, with a pass, fail or not-checked result and evidence for each of 16 checks. Retrofit reads public pages only, follows robots.txt for RetrofitBot and keeps each site's result for 24 hours. A call waits up to 25 seconds. A 202 answer means the score is still running: call again with the same URL after retryAfterSeconds. Errors are JSON with error, message and, when a later call can help, retryAfterSeconds. No key, cookie or account is needed.";

export default function BotPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 leading-relaxed">
      <p>
        <Link href="/" className="underline">
          Retrofit
        </Link>
      </p>
      <h1 className="mt-4 text-3xl font-semibold">RetrofitBot</h1>
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
        <li>At most one request per second to a host, or your Crawl-delay if it is longer. Above 10 seconds it reads only the home page.</li>
        <li>At most 2 MB per page, 8 seconds per request and 45 seconds per site.</li>
        <li>Results are kept for 24 hours. It sends no cookies and keeps no email addresses.</li>
        <li>It reads only public addresses on ports 80 and 443.</li>
      </ul>
      <h2 className="mt-8 text-xl font-semibold">How to block it</h2>
      <p className="mt-2">Add these lines to your robots.txt. RetrofitBot then stops and reads nothing else from your site.</p>
      <pre className="mt-2 rounded border p-3" style={{ borderColor: "var(--color-border)" }}>
        {"User-agent: RetrofitBot\nDisallow: /"}
      </pre>
      <h2 className="mt-8 text-xl font-semibold">For agents</h2>
      <p className="mt-2" id="score-api">
        {ENDPOINT_DESCRIPTION}
      </p>
    </main>
  );
}
