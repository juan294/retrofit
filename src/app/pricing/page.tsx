import type { Metadata } from "next";
import Link from "next/link";
import { NotifyForm } from "@/components/NotifyForm";
import { FEATURE_LABELS, PLANS } from "@/lib/billing/plans";
import { getServerDeps } from "@/lib/server/runtime";
import { PRICING_TEXT, pricingNotice } from "@/lib/site/pricing-texts";

export const metadata: Metadata = { title: "Pricing · Retrofit" };

export default function PricingPage() {
  const { config, clock } = getServerDeps();
  const notice = pricingNotice(clock(), config.billingStart);
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 leading-relaxed [overflow-wrap:anywhere]">
      <p>
        <Link href="/" className="underline">
          Retrofit
        </Link>
      </p>
      <h1 className="mt-4 text-3xl font-semibold">{PRICING_TEXT.title}</h1>
      <p className="mt-4">{PRICING_TEXT.intro}</p>
      {notice ? (
        <p className="mt-4 rounded border p-3" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
          <strong>{notice}.</strong> {PRICING_TEXT.freeNoticeDetail}
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
    </main>
  );
}
