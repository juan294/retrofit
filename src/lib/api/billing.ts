import { BILLING_ACTIONS_PER_HOUR } from "@/lib/accounts/limits";
import type { Account } from "@/lib/accounts/session";
import { checkoutPrice, requireBillingUrl, startCheckout } from "@/lib/billing/checkout";
import { isPaidPlan } from "@/lib/billing/plans";
import { logBillingFailure } from "@/lib/billing/sync";
import type { ServerDeps } from "@/lib/server/runtime";
import { BILLING_TEXT as T } from "@/lib/site/billing-texts";
import { accountPost, type Fields } from "./account-post";
import { json } from "./json";
import { countIn } from "./limits";

type Deps = Pick<ServerDeps, "config" | "store" | "accounts" | "billing" | "clock" | "sleep">;

/** An accountPost whose Stripe failures are 503 unavailable, logged with an operation and a code only. */
function billingPost(name: string, request: Request, deps: Deps, body: (account: Account, fields: Fields) => Promise<Response>): Promise<Response> {
  return accountPost(name, T, request, deps, async (account, fields) => {
    try {
      return await body(account, fields);
    } catch (e) {
      logBillingFailure(`POST ${name}`, e);
      return json(503, { error: "unavailable", message: T.unavailable });
    }
  });
}

const limited = (deps: Deps, accountId: string) => countIn(deps, "billing-action", BILLING_ACTIONS_PER_HOUR, accountId, T.limit);

const REFUSED = {
  not_started: [403, T.notStarted],
  no_price: [409, T.noPrice],
  subscribed: [409, T.subscribed],
  no_account: [401, T.signedOut],
  busy: [409, T.checkoutBusy],
} as const;

/**
 * POST /api/billing/checkout `{plan}` -> 200 `{url}`: a hosted Stripe Checkout for the plan's configured
 * price. The page navigates to it with location.assign, so the page policy's form-action stays 'self'.
 * An accountPost; 400 invalid (not a paid plan), 403 not_started, 409 no_price, busy or subscribed
 * `{portal: true}`, 429 limit past BILLING_ACTIONS_PER_HOUR, 503 unavailable.
 */
export function handleCheckout(request: Request, deps: Deps): Promise<Response> {
  return billingPost("/api/billing/checkout", request, deps, async (account, { plan }) => {
    if (!isPaidPlan(plan)) return json(400, { error: "invalid", message: T.invalid });
    const price = checkoutPrice(deps, plan);
    const refusal = "code" in price ? price.code : null;
    if (refusal === null) {
      const tooMany = await limited(deps, account.accountId);
      if (tooMany) return tooMany;
    }
    const result = refusal === null ? await startCheckout(deps, account, plan) : { ok: false as const, code: refusal };
    if (result.ok) return json(200, { url: result.url });
    const [status, message] = REFUSED[result.code];
    return json(status, { error: result.code, message, ...(result.code === "subscribed" ? { portal: true } : {}) });
  });
}

/** POST /api/billing/portal -> 200 `{url}`: the customer portal of the account's own customer. An accountPost; 404 no_customer, 429 limit, 503 unavailable. */
export function handlePortal(request: Request, deps: Deps): Promise<Response> {
  return billingPost("/api/billing/portal", request, deps, async ({ accountId }) => {
    const record = await deps.accounts.getBilling(accountId);
    if (!record) return json(404, { error: "no_customer", message: T.noCustomer });
    const tooMany = await limited(deps, accountId);
    if (tooMany) return tooMany;
    const url = await deps.billing.createPortal({ customerId: record.customerId, returnUrl: `${deps.config.publicOrigin}/account` });
    return json(200, { url: requireBillingUrl(deps, "createPortal", url) });
  });
}
