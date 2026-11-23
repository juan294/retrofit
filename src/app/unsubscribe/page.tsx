import type { Metadata } from "next";
import Link from "next/link";
import { unsubscribePageState } from "@/lib/api/unsubscribe";
import { UNSUBSCRIBE_TEXT } from "@/lib/site/pricing-texts";

export const metadata: Metadata = {
  title: "Unsubscribe · Retrofit",
  robots: { index: false, follow: false },
};

/**
 * GET /unsubscribe?t=<token>: the link every message carries (unsubscribeUrl). Opening it changes
 * nothing; the button posts the token to /api/unsubscribe, which redirects back with ?result=.
 */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = unsubscribePageState(await searchParams);
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 leading-relaxed [overflow-wrap:anywhere]">
      <p>
        <Link href="/" className="underline">
          Retrofit
        </Link>
      </p>
      <h1 className="mt-4 text-3xl font-semibold">{UNSUBSCRIBE_TEXT.title}</h1>
      {state.kind === "confirm" ? (
        <form method="post" action="/api/unsubscribe" className="mt-4 flex flex-col items-start gap-3">
          <p>{UNSUBSCRIBE_TEXT.confirm}</p>
          <input type="hidden" name="t" value={state.token} />
          <button type="submit" className="rounded px-4 py-2 font-medium" style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}>
            {UNSUBSCRIBE_TEXT.confirmButton}
          </button>
        </form>
      ) : (
        <p className="mt-4" role={state.outcome === "done" ? "status" : "alert"}>
          {UNSUBSCRIBE_TEXT[state.outcome]}
        </p>
      )}
    </main>
  );
}
