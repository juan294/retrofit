import Link from "next/link";
import { connection } from "next/server";
import { UrlForm } from "@/components/UrlForm";
import { AgentPanel } from "@/components/preview/AgentPanel";

export default async function Home() {
  // Render per request so that each response carries its own CSP nonce.
  await connection();
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-4xl font-semibold">Retrofit</h1>
      <p className="mt-4 text-lg" style={{ color: "var(--color-muted)" }}>
        An agent on your own website that can take the order, and it is yours to keep.
      </p>
      <UrlForm />
      <p className="mt-6 text-sm" style={{ color: "var(--color-muted)" }}>
        Retrofit reads your public pages, your robots.txt, sitemap, llms.txt and agent manifest. It skips sign-in, account and checkout
        pages and follows your robots rules. <Link href="/bot" className="underline">How RetrofitBot reads your site</Link>.
      </p>
      <AgentPanel basePath="" title="Ask Retrofit's own agent" />
    </main>
  );
}
