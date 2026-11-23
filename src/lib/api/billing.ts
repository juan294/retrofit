import { BILLING_ACTIONS_PER_HOUR } from "@/lib/accounts/limits";
import { checkoutPrice, requireBillingUrl, startCheckout } from "@/lib/billing/checkout";
import { isPaidPlan } from "@/lib/billing/plans";
import type { ServerDeps } from "@/lib/server/runtime";
import { BILLING_TEXT as T } from "@/lib/site/billing-texts";
import { accountPost } from "./account-post";
import { json } from "./json";
import { countIn } from "./limits";

type Deps = Pick<ServerDeps, "config" | "store" | "accounts" | "billing" | "clock" | "sleep">;

const limited = (deps: Deps, accountId: string) => countIn(deps, "billing-action", BILLING_ACTIONS_PER_HOUR, accountId, T.limit);

const REFUSED = {
  not_started: [403, T.notStarted],
  no_price: [409, T.noPrice],
  subscribed: [409, T.subscribed],
  no_account: [401, T.signedOut],
  busy: [409, T.checkoutBusy],
} as const;

function refused(code: keyof typeof REFUSED): Response {
  const [status, message] = REFUSED[code];
  return json(status, { error: code, message, ...(code === "subscribed" ? { portal: true } : {}) });
}

/**
 * POST /api/billing/checkout `{plan}` -> 200 `{url}`: a hosted Stripe Checkout for the plan's configured
 * price. The page navigates to it with location.assign, so the page policy's form-action stays 'self'.
 * An accountPost; 400 invalid (not a paid plan), 403 not_started, 409 no_price, busy or subscribed
 * `{portal: true}`, 429 limit past BILLING_ACTIONS_PER_HOUR, 503 unavailable.
 */
export function handleCheckout(request: Request, deps: Deps): Promise<Response> {
  return accountPost("/api/billing/checkout", T, request, deps, async (account, { plan }) => {
    if (!isPaidPlan(plan)) return json(400, { error: "invalid", message: T.invalid });
    const price = checkoutPrice(deps, plan);
    if ("code" in price) return refused(price.code);
    const tooMany = await limited(deps, account.accountId);
    if (tooMany) return tooMany;
    const result = await startCheckout(deps, account, price.priceId);
    return result.ok ? json(200, { url: result.url }) : refused(result.code);
  });
}

/** POST /api/billing/portal -> 200 `{url}`: the customer portal of the account's own customer. An accountPost; 404 no_customer, 429 limit, 503 unavailable. */
export function handlePortal(request: Request, deps: Deps): Promise<Response> {
  return accountPost("/api/billing/portal", T, request, deps, async ({ accountId }) => {
    const record = await deps.accounts.getBilling(accountId);
    if (!record) return json(404, { error: "no_customer", message: T.noCustomer });
    const tooMany = await limited(deps, accountId);
    if (tooMany) return tooMany;
    const url = await deps.billing.createPortal({ customerId: record.customerId, returnUrl: `${deps.config.publicOrigin}/account` });
    return json(200, { url: requireBillingUrl(deps, "createPortal", url) });
  });
}
