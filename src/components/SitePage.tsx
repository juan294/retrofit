import type { ReactNode } from "react";
import { PageShell } from "./PageShell";

/** The shell of Retrofit's text pages (bot, pricing, privacy, terms, unsubscribe, sign-in, account): the navigation, the title and the footer. */
export function SitePage({ title, form, children }: { title: string; form?: string; children: ReactNode }) {
  return (
    <PageShell form={form}>
      <main className="fi-main fi-main-text">
        <h1 className="fi-display fi-page-title">{title}</h1>
        {children}
      </main>
    </PageShell>
  );
}
