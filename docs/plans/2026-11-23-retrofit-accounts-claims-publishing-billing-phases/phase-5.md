# Phase 5: billing, entitlements, the free limit and API keys

Parent plan: [2026-11-23-retrofit-accounts-claims-publishing-billing.md](../2026-11-23-retrofit-accounts-claims-publishing-billing.md).

## Entry conditions

- Phase 4 accepted (or continuation authorized). Rebase on current `develop`.
- Local work uses a fake Stripe client and signed fixture events; no Stripe account is needed to build and test.

## External actions (each needs Juan's authorization)

1. Create the Stripe account (or use an existing one) and its test-mode products Pro and Agency with monthly prices; amounts are Juan's decision and may stay unset until billing starts.
2. Test-mode secret key and a test webhook endpoint `https://retrofit.thecreativetoken.com/api/billing/webhook` with its signing secret.
3. Production variables: `BILLING_START=2027-01-20T00:00:00Z`; optional until that instant (owner decision 2026-11-25), both or neither: `STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SECRET`; `STRIPE_PRICE_PRO`, `STRIPE_PRICE_AGENCY` (optional until set).
4. Live mode (live keys, live webhook, live prices) is out of this plan: a separate authorized release after 2027-01-18.

## Changes

```
@ entitlement(request, feature) -> allowed | {denied, reason, prompt}
ctx: Config.billingStart, clock, readAccount, AccountData.billing, plans.ts
do:
  1. compute now < billingStart -> allowed for every feature (today's behavior, signed in or not, within existing caps)
  2. lookup account and plan (Free when none or not active)
  3. compute plans.ts[plan].features includes feature
br: anonymous analysis after billingStart -> allowed while the free count < 5, else denied with the sign-in prompt
fail: billing data unreadable -> allow analyses, deny paid writes with a retry text (never charge-blocking a visit)
```

- `src/lib/billing/entitlements.ts` (above), called at: analysis start (free limit), publish and refresh, save report, API key creation (the free-AI session check was removed by the owner decision of 2026-11-25).
- Free count: per visitor cookie and per network (`incrementWindow` with a long window); judges unaffected before `billingStart` by construction; after it, the judge code stops mattering because judging has ended.
- `src/app/api/billing/checkout/route.ts`: signed-in only; creates a Checkout Session (subscription mode, the price for the plan, `client_reference_id` = account id, success and cancel URLs); returns its URL and the page navigates with `location.assign` (no form post to another origin, so `form-action 'self'` stays).
- `src/app/api/billing/portal/route.ts`: a customer portal session for the account's customer.
- `src/app/api/billing/webhook/route.ts`: raw body, signature check with `stripe.webhooks.constructEvent`, `stripe_events` insert first (duplicate -> 200 and stop), then `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted` update `billing_customers`.
- Account page: plan, renewal date, "Manage billing"; reconciliation from Stripe on load when the stored state is older than 10 minutes.
- API keys: create (shown once, hash stored), list, revoke; `/api/score` accepts `Authorization: Bearer rk_...` and applies the plan's hourly limit instead of the anonymous one.
- `/pricing`: amounts shown when the price ids are set; "Upgrade" buttons appear only from `billingStart`; before it, "notify me" stays.
- Account deletion: cancel the subscription first (Phase 2's deletion gains this step).

## Tests (TDD, red first)

- `tests/billing/entitlements.test.ts`: table of plan by feature on both sides of `billingStart` (fixtures clock).
- `tests/billing/free-limit.test.ts`: before the start, 6 analyses succeed for one anonymous visitor; after it, the sixth gets the sign-in prompt; a signed-in Free account continues.
- `tests/billing/webhook.test.ts`: bad signature 400; replay of one event applied once; each event type updates the row; unknown types acknowledged and ignored.
- `tests/billing/reconcile.test.ts`: a missed webhook is fixed on account load; Stripe unreachable shows the activating text.
- `tests/api/score-keys.test.ts`: a valid key gets the plan limit; a revoked key is refused with a recovery text; keys are never logged.
- `e2e/billing.spec.ts` (fixtures clock after `billingStart`, fake Stripe that redirects back): upgrade to Pro, publish now allowed; cancel returns to `/pricing` with the cancelled text.
- Existing `e2e/free-path.spec.ts` and the production `judge-path` case unchanged.

## Exit criteria

- Parent success criteria 7 and 8 pass; 9 for the account and pricing changes.
- Full gate, analyzer ACCEPTED, required tests updated.
- Review, repair, simplify, handoff. Stop for acceptance. Owner manual check 4 after the release that includes it.
