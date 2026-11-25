/**
 * The navigation of every Retrofit page: home, the plans and the account. The same for every visitor:
 * /account itself sends a signed-out visitor to sign-in, so no page reads the account or a cookie for it.
 * Plain links, because a client link would prefetch the account page.
 */
export function SiteNav() {
  return (
    <nav aria-label="Retrofit" className="flex flex-wrap gap-x-4 gap-y-1">
      <a href="/" className="underline">
        Retrofit
      </a>
      <a href="/pricing" className="underline">
        Pricing
      </a>
      <a href="/account" className="underline">
        Account
      </a>
    </nav>
  );
}
