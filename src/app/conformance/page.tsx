import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { SiteNav } from "@/components/SiteNav";
import { AgentPanel } from "@/components/preview/AgentPanel";
import { CONFORMANCE_FIXTURES, CONFORMANCE_NETWORK } from "@/lib/peer/conformance";
import { PEER_ORIGIN, RETROFIT_ORIGIN } from "@/lib/peer/host";

export const metadata: Metadata = {
  title: "Conformance · Retrofit",
  description: "Retrofit's published open agentic web conformance fixtures, and a chat that runs them.",
};

/**
 * Retrofit's published conformance fixtures (phase-7.md, "Production peer"). Permanent and
 * public: the network, the peer and this page are the same for every visitor and every
 * deployment. The chat boots retrofit_conformance through Preview, so the page's fetch
 * guard and CSP apply as on every other agent page.
 */
export default async function Conformance() {
  // Render per request so that each response carries its own CSP nonce.
  await connection();
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <SiteNav />
      <h1 className="mt-8 text-4xl font-semibold">Conformance fixtures</h1>
      <p className="mt-4" style={{ color: "var(--color-muted)" }}>
        Retrofit publishes a small agent network, <code>{CONFORMANCE_NETWORK}</code>, that calls one working partner network and three that must fail safely.
        Other sites and the organizers&apos; partner check can read it at <code className="break-all">{`${RETROFIT_ORIGIN}/${CONFORMANCE_NETWORK}`}</code>. The partner networks are on{" "}
        <a href={PEER_ORIGIN} className="underline">
          Harbor tours demo
        </a>
        , Retrofit&apos;s synthetic site with fictional tours. This network is separate from{" "}
        <Link href="/" className="underline">
          Retrofit&apos;s own agent
        </Link>
        .
      </p>

      <h2 className="mt-10 text-xl font-semibold">The fixtures</h2>
      <dl className="mt-4 flex flex-col gap-4" data-testid="conformance-fixtures">
        {CONFORMANCE_FIXTURES.map((f) => (
          <div key={f.tool}>
            <dt className="font-medium">
              {f.label} (<code>{f.tool}</code>)
            </dt>
            <dd className="mt-1 text-sm">
              <code className="break-all">{f.url}</code>
              <br />
              {f.expect}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-6 text-sm" style={{ color: "var(--color-muted)" }}>
        The runtime also limits each message to 4 partner calls in total and 1 call per partner; a turn that asks for more shows a limit notice.
      </p>

      <AgentPanel basePath="" network={CONFORMANCE_NETWORK} title="Run the fixtures" />
    </main>
  );
}
