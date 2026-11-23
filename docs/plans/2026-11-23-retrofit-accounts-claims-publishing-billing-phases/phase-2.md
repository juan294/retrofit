# Phase 2: accounts

Parent plan: [2026-11-23-retrofit-accounts-claims-publishing-billing.md](../2026-11-23-retrofit-accounts-claims-publishing-billing.md).

## Entry conditions

- Phase 1 accepted (or continuation authorized). Rebase on current `develop`.
- Local work needs no external action. `supabase/config.toml` today runs Auth with sign-up off and `[local_smtp]` disabled (verified 2026-11-23); this phase turns on email sign-up and the local mail catcher, gives the catcher a port inside the gate stack's reserved range (`docs/development/resource-lifecycle.md`) and records it there. Unit tests use a fake auth client and mailer.

## External actions (each needs Juan's authorization; none blocks local work)

1. Request SES production access for `us-east-1` with a transactional use statement (sign-in links only). Release of this phase waits for the grant.
2. Create SES SMTP credentials (an IAM user limited to `ses:SendRawEmail` from `no-reply@thecreativetoken.com`); store them only in Supabase.
3. Supabase project `retrofit` Auth settings: email sign-up on (other providers off), custom SMTP (SES), sender `Retrofit <no-reply@thecreativetoken.com>`, site URL and redirect allow-list `https://retrofit.thecreativetoken.com/auth/confirm`, the email template that links to `/auth/confirm?token_hash={{ .TokenHash }}&type=email`, email OTP expiry 1 hour.
4. Production variables: `SUPABASE_ANON_KEY` (server use only), `ACCOUNT_SESSION_SECRET`.

## Changes

```
@ handleSignIn(request) -> Response
ctx: Supabase Auth client (anon key), Store windows, Config
pre: same-origin POST; JSON {email, returnTo}
do:
  1. validate email and returnTo (same-origin path only)
  2. count per network (5/hour) and per email (3/hour)
  3. call signInWithOtp(email, emailRedirectTo /auth/confirm?next=returnTo)
  4. emit 200 {sent: true} for every valid address
fail: limit -> 429 retryAt; send error -> 503 mail_unavailable text
```

- `src/lib/accounts/session.ts`: `retrofit_account` cookie (HttpOnly, SameSite=Lax, Secure, Path=/), a random id whose hash keys a Store session record (30 days, sliding); `readAccount(request)`.
- `src/app/auth/confirm/route.ts`: `verifyOtp({token_hash, type})`, profile upsert, session, attach the visitor's analyses (`accountId` on the analysis record; `createAnalysis` gains the optional field), redirect to `next`.
- `src/app/account/page.tsx`: email, saved reports, sign-out, delete account; `src/app/sign-in/page.tsx` with the form.
- Owner checks for `/r/<id>`, `/p/<id>/*` and status accept either the visitor cookie (as today) or the account the analysis is attached to.
- Saved reports: "Save this report" on a results page for signed-in visitors writes `saved_reports`; the account page lists them and opens a read-only report view.
- Account deletion: delete rows, Store sessions, then `auth.admin.deleteUser`; Phase 5 adds the subscription cancel step before it.
- `robots.ts`: disallow `/account`, `/auth/`, `/sign-in`.

## Tests (TDD, red first)

- `tests/accounts/sign-in.test.ts`: same answer for known and unknown addresses; limits per network and per email with `retryAt`; 503 text on a mailer failure; `returnTo` refuses other origins and `//` paths.
- `tests/accounts/confirm.test.ts`: success sets the cookie and attaches analyses; expired or reused token shows the send-again page; no Supabase token in any header or body.
- `tests/accounts/session.test.ts`: cookie attributes, sliding expiry, sign-out removes the record.
- `tests/accounts/delete.test.ts`: every owned row removed; the auth user deleted last; a failure leaves data intact and says so.
- `tests/db/auth.db.test.ts` on the gate stack: a real `signInWithOtp` reaches Inbucket, the link's token verifies once.
- `e2e/account.spec.ts`: sign in through the local mail catcher, save a report, open it from the account page, sign out, delete.
- Existing `e2e/analyze.spec.ts`, `e2e/preview.spec.ts`: unchanged behavior for anonymous visitors.

## Exit criteria

- Parent success criterion 3 passes; 8 and 9 hold.
- Full gate (the gate stack now includes Auth), analyzer ACCEPTED, required tests updated.
- Review, repair, simplify, handoff. Stop for acceptance. Release needs external actions 1 to 4 done and owner manual check 2 after deployment.
