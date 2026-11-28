import { CONTACT_URL, SOURCE_URL } from "@/lib/site/own-site";

/** The footer of every page in the shell: the plans, the two legal pages, the source code and the contact address. */
export function SiteFooter() {
  return (
    <footer className="fi-footer">
      <nav aria-label="Footer">
        <a href="/pricing">Pricing</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href={SOURCE_URL}>Source code</a>
        <a href={CONTACT_URL}>Contact</a>
      </nav>
      <span aria-hidden="true" className="fi-display fi-footer-mark">
        Retrofit
      </span>
    </footer>
  );
}
