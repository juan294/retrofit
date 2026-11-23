import type { Metadata } from "next";
import { NotifyForm } from "@/components/NotifyForm";
import { SitePage } from "@/components/SitePage";
import { FEATURE_LABELS, PLANS } from "@/lib/billing/plans";
import { getConfig } from "@/lib/config";
import { serverClock } from "@/lib/server/runtime";
import { PRICING_TEXT } from "@/lib/site/pricing-texts";

export const metadata: Metadata = { title: "Pricing · Retrofit" };

export default function PricingPage() {
  const config = getConfig();
  const free = serverClock(config)() < config.billingStart;
  return (
    <SitePage title={PRICING_TEXT.title}>
      <p className="mt-4">{PRICING_TEXT.intro}</p>
      {free ? (
        <p className="mt-4 rounded border p-3" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
          {PRICING_TEXT.freeNotice}
        </p>
      ) : null}
      <ul className="mt-8 flex flex-col gap-4">
        {PLANS.map((plan) => (
          <li key={plan.id} className="rounded border p-4" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
            <h2 className="text-xl font-semibold">{plan.name}</h2>
            <p className="mt-1" style={{ color: "var(--color-muted)" }}>
              {plan.summary}
            </p>
            <ul className="mt-2 list-disc pl-6">
              {plan.features.map((f) => (
                <li key={f}>{FEATURE_LABELS[f]}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <h2 className="mt-10 text-xl font-semibold">{PRICING_TEXT.notifyHeading}</h2>
      <NotifyForm privacyHref="/privacy" />
    </SitePage>
  );
}
