import type { Metadata } from "next";
import { NotifyForm } from "@/components/NotifyForm";
import { SitePage } from "@/components/SitePage";
import { BillingButton } from "@/components/billing/BillingButton";
import { fixtureOriginOf } from "@/lib/billing/checkout";
import { billingStarted } from "@/lib/billing/entitlements";
import { FEATURE_LABELS, isPaidPlan, PLANS } from "@/lib/billing/plans";
import { planAmounts, planOffer } from "@/lib/billing/prices";
import { getServerDeps } from "@/lib/server/runtime";
import { BILLING_TEXT } from "@/lib/site/billing-texts";
import { PRICING_TEXT } from "@/lib/site/pricing-texts";

export const metadata: Metadata = { title: "Pricing · Retrofit" };

/**
 * /pricing[?checkout=cancelled]: the plans and their features. Amounts only for plans with a configured
 * Stripe price; an upgrade button only from BILLING_START on and beside its amount (planOffer); "Notify me" until then, and while no plan
 * can be bought.
 */
export default async function PricingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { checkout } = await searchParams;
  const deps = getServerDeps();
  const free = !billingStarted(deps);
  const prices = deps.config.billing?.prices ?? {};
  const unpriced = Object.keys(prices).length === 0;
  const amounts = await planAmounts(deps);
  const fixtureOrigin = fixtureOriginOf(deps.config);
  return (
    <SitePage title={PRICING_TEXT.title}>
      {checkout === "cancelled" ? (
        <p className="mt-4" role="status">
          {BILLING_TEXT.cancelled}
        </p>
      ) : null}
      <p className="mt-4">{PRICING_TEXT.intro}</p>
      {free ? (
        <p className="mt-4 rounded border p-3" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
          {unpriced ? `${PRICING_TEXT.freeNotice} ${PRICING_TEXT.pricesNotSet}` : PRICING_TEXT.freeNotice}
        </p>
      ) : null}
      <p className="mt-4">
        {PRICING_TEXT.accountBefore}
        <a href="/account" className="underline">
          {PRICING_TEXT.accountLink}
        </a>
      </p>
      <ul className="mt-8 flex flex-col gap-4">
        {PLANS.map((plan) => {
          const offer = isPaidPlan(plan.id) ? planOffer({ started: !free, priced: prices[plan.id] !== undefined, amount: amounts[plan.id] }) : null;
          return (
            <li key={plan.id} className="rounded border p-4" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
              <h2 className="text-xl font-semibold">{plan.name}</h2>
              <p className="mt-1" style={{ color: "var(--color-muted)" }}>
                {plan.summary}
              </p>
              {offer?.amount ? (
                <p className="mt-2 font-medium" data-testid={`price-${plan.id}`}>
                  {offer.amount}
                </p>
              ) : null}
              {offer?.unavailable ? <p className="mt-2">{PRICING_TEXT.priceUnavailable}</p> : null}
              <ul className="mt-2 list-disc pl-6">
                {plan.features.map((f) => (
                  <li key={f}>{FEATURE_LABELS[f]}</li>
                ))}
              </ul>
              {offer?.upgrade ? <BillingButton path="/api/billing/checkout" body={{ plan: plan.id }} label={BILLING_TEXT.upgrade(plan.name)} returnTo="/pricing" fixtureOrigin={fixtureOrigin} /> : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-6">{PRICING_TEXT.aiNote}</p>
      {free || unpriced ? (
        <>
          <h2 className="mt-10 text-xl font-semibold">{PRICING_TEXT.notifyHeading}</h2>
          <NotifyForm privacyHref="/privacy" />
        </>
      ) : null}
    </SitePage>
  );
}
