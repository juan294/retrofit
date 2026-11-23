import type { BillingView } from "@/lib/billing/view";
import { BILLING_TEXT as T } from "@/lib/site/billing-texts";
import { PLAN_TEXT } from "@/lib/site/plan-texts";
import { BillingButton } from "./BillingButton";

/** "Your plan" on /account, from BILLING_START on. `view` is null when the plan could not be read. */
export function BillingSection({ view, fixtureOrigin }: { view: BillingView | null; fixtureOrigin: string | null }) {
  return (
    <section data-testid="billing">
      <h2 className="mt-10 text-xl font-semibold">{T.heading}</h2>
      {view === null ? (
        <p className="mt-2" role="alert">
          {T.unreadable}
        </p>
      ) : (
        <>
          <p className="mt-2">
            <strong data-testid="plan-name">{view.planName}</strong>
            {view.detail ? <span data-testid="plan-detail"> {view.detail}</span> : null}
          </p>
          {view.activating ? (
            <p className="mt-2" role="status" data-testid="plan-activating">
              {T.activating}
            </p>
          ) : null}
          <p className="mt-2">
            <a href="/pricing" className="underline">
              {PLAN_TEXT.seePlans}
            </a>
          </p>
          {view.manage ? <BillingButton path="/api/billing/portal" label={T.manage} returnTo="/account" fixtureOrigin={fixtureOrigin} primary={false} /> : null}
        </>
      )}
    </section>
  );
}
