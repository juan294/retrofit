import type { ReactNode } from "react";
import { SiteNav } from "./SiteNav";

/** The shell of Retrofit's text pages (bot, pricing, privacy, terms, unsubscribe): the navigation and the title. */
export function SitePage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 leading-relaxed [overflow-wrap:anywhere]">
      <SiteNav />
      <h1 className="mt-4 text-3xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}
