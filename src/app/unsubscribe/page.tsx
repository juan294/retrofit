import type { Metadata } from "next";
import Link from "next/link";
import { unsubscribeByToken } from "@/lib/api/unsubscribe";
import { getServerDeps } from "@/lib/server/runtime";
import { UNSUBSCRIBE_TEXT } from "@/lib/site/pricing-texts";

export const metadata: Metadata = {
  title: "Unsubscribe · Retrofit",
  robots: { index: false, follow: false },
};

/** GET /unsubscribe?t=<token>: the link every message carries (unsubscribeUrl). */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { t } = await searchParams;
  const outcome = await unsubscribeByToken(t, getServerDeps().accounts);
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-3xl font-semibold">{UNSUBSCRIBE_TEXT.title}</h1>
      <p className="mt-4" role={outcome === "done" ? "status" : "alert"}>
        {UNSUBSCRIBE_TEXT[outcome]}
      </p>
      <p className="mt-6">
        <Link href="/" className="underline">
          {UNSUBSCRIBE_TEXT.home}
        </Link>
      </p>
    </main>
  );
}
