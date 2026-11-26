import type { ReactNode } from "react";
import { SiteFooter } from "./SiteFooter";
import { SiteNav } from "./SiteNav";

/**
 * The frame of a page: the header with the navigation, the page's own `<main>` (the children) and the footer.
 * The paper background, the fonts and the column that keeps the footer at the bottom come from `<body>` (layout.tsx).
 */
export function PageShell({ form, children }: { form?: string; children: ReactNode }) {
  return (
    <>
      <header className="fi-header">
        <SiteNav form={form} />
      </header>
      {children}
      <SiteFooter />
    </>
  );
}
