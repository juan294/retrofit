/**
 * The navigation of every Retrofit page: home, the plans and the account. The same for every visitor:
 * /account itself sends a signed-out visitor to sign-in, so no page reads the account or a cookie for it.
 * Plain links, because a client link would prefetch the account page. The three links come first and in
 * this order on every page. `form` is the page's form label ("Form R-01 · …"): decoration beside the wordmark.
 */
export function SiteNav({ form }: { form?: string }) {
  return (
    <nav aria-label="Retrofit" className="fi-nav">
      <a href="/" className="fi-wordmark">
        Retrofit
      </a>
      {form ? (
        <span aria-hidden="true" className="fi-mono fi-form-label fi-desk">
          {form}
        </span>
      ) : null}
      <a href="/pricing">Pricing</a>
      <a href="/account">Account</a>
    </nav>
  );
}
