import { isCustomerId, isUuid, type BillingRecord } from "@/lib/accounts/data";
import { WebhookRefused, type BillingEvent } from "@/lib/billing/gateway";
import { logBillingFailure, readStripe } from "@/lib/billing/sync";
import type { ServerDeps } from "@/lib/server/runtime";
import { readLimitedBody } from "./body";
import { json } from "./json";

type Deps = Pick<ServerDeps, "config" | "accounts" | "auth" | "billing" | "clock">;

/** Stripe's events are a few kilobytes; a larger body is refused before its signature is checked. */
export const MAX_WEBHOOK_BYTES = 512 * 1024;

const COMPLETED = "checkout.session.completed";
const UPDATED = "customer.subscription.updated";
const DELETED = "customer.subscription.deleted";

/**
 * POST /api/billing/webhook: Stripe's events (phase-5.md). No cookie and no same-origin rule: the
 * signature over the raw body is the authority. 413 too_large, 400 bad_signature (wrong, missing or over
 * five minutes old), 400 live_mode (test mode only), 200 for every other event, also the types it
 * ignores. 503 when Stripe, the sign-in provider or the database fails: Stripe sends the event again.
 *
 * An event only says which customer changed. Its state is read again from Stripe and applied together
 * with the event's record in one transaction (AccountData applyBillingEvent): a replay applies nothing,
 * an event that arrives late finds the current state, and an older read never replaces a newer one.
 */
export async function handleBillingWebhook(request: Request, deps: Deps): Promise<Response> {
  if (!deps.config.billing) return json(503, { error: "not_configured" });
  const payload = await readLimitedBody(request, MAX_WEBHOOK_BYTES);
  if (payload === "too large") return json(413, { error: "too_large" });
  try {
    const event = await deps.billing.verifyWebhook(payload, request.headers.get("stripe-signature"), deps.clock());
    if (event.livemode) {
      console.error("POST /api/billing/webhook refused a live-mode event.");
      return json(400, { error: "live_mode" });
    }
    if (event.type === COMPLETED || event.type === UPDATED || event.type === DELETED) await applyEvent(event, deps);
    return json(200, { received: true });
  } catch (e) {
    if (e instanceof WebhookRefused) return json(400, { error: "bad_signature" });
    logBillingFailure("POST /api/billing/webhook", e);
    return json(503, { error: "unavailable" });
  }
}

async function applyEvent(event: BillingEvent, deps: Deps): Promise<void> {
  const { customerId } = event;
  if (!isCustomerId(customerId)) return;
  // A one-time checkout is not Retrofit's.
  if (event.type === COMPLETED && event.mode !== "subscription") return;

  let record = await deps.accounts.getBillingByCustomer(customerId);
  if (event.type === COMPLETED) {
    if (record && record.accountId !== event.clientReferenceId) {
      console.error("POST /api/billing/webhook ignored a checkout whose reference is not its customer's account.");
      return;
    }
    record ??= await relink(customerId, event.clientReferenceId, deps);
  }
  if (record) {
    const { observed } = await readStripe(deps, customerId);
    const applied = await deps.accounts.applyBillingEvent({ id: event.id, type: event.type }, customerId, observed);
    if (applied.outcome !== "unknown") return;
  }
  if (event.type !== DELETED) await cancelOrphan(customerId, deps);
}

/**
 * A completed checkout of a customer without a record (its account's data was deleted, or restored from
 * before the checkout): bound again only to the account the customer was created for by this Retrofit,
 * which the checkout also names and which still exists, and which has no other customer.
 */
async function relink(customerId: string, reference: string | null, deps: Deps): Promise<BillingRecord | null> {
  if (reference === null || !isUuid(reference)) return null;
  const owner = await deps.billing.customerOwner(customerId);
  if (owner?.accountId !== reference || owner.origin !== deps.config.publicOrigin) return null;
  if ((await deps.auth.getUser(reference)) === null) return null;
  const linked = await deps.accounts.linkBillingCustomer(reference, customerId);
  return linked.outcome === "linked" || (linked.outcome === "existing" && linked.billing.customerId === customerId) ? linked.billing : null;
}

/**
 * An event of a customer without a record. When this Retrofit created the customer for an account that
 * no longer exists, a checkout was paid while the account was being deleted: its subscription is
 * cancelled, and no row is created. Every other customer is another product's, another deployment's or
 * a living account's, and is left alone.
 */
async function cancelOrphan(customerId: string, deps: Deps): Promise<void> {
  const owner = await deps.billing.customerOwner(customerId);
  if (!owner || owner.origin !== deps.config.publicOrigin || !isUuid(owner.accountId)) return;
  if ((await deps.auth.getUser(owner.accountId)) !== null) {
    console.error("POST /api/billing/webhook: a customer of an existing account has no billing record.");
    return;
  }
  await deps.billing.cancelSubscriptions(customerId);
  console.error("POST /api/billing/webhook cancelled the subscription of a deleted account.");
}
