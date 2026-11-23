import Link from "next/link";
import type { ReactNode } from "react";

/** The shell of Retrofit's text pages (bot, pricing, privacy, terms, unsubscribe): a home link and the title. */
export function SitePage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 leading-relaxed [overflow-wrap:anywhere]">
      <p>
        <Link href="/" className="underline">
          Retrofit
        </Link>
      </p>
      <h1 className="mt-4 text-3xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}
