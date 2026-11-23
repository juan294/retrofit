import { isCustomerId, isUuid, type BillingRecord } from "@/lib/accounts/data";
import { BillingUnavailable, WebhookRefused, type BillingEvent } from "@/lib/billing/gateway";
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
/** Reads of Stripe for one event, when other instances keep storing newer ones. */
const APPLY_ATTEMPTS = 3;

/**
 * POST /api/billing/webhook: Stripe's events (phase-5.md). No cookie and no same-origin rule: the
 * signature over the raw body is the authority. 413 too_large, 400 bad_signature (wrong, missing or over
 * five minutes old), 400 live_mode (test mode only), 200 for every other event, also the types it
 * ignores. 503 when Stripe, the sign-in provider or the database fails: Stripe sends the event again.
 *
 * An event only says which customer changed. Its state is read again from Stripe and applied together
 * with the event's record in one transaction (AccountData applyBillingEvent): a replay applies nothing,
 * an event that arrives late finds the current state, and an older read never replaces a newer one. A
 * subscription is cancelled only for a customer that deleteAccountData marked as deleted.
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
  if (record && event.type === COMPLETED && record.accountId !== event.clientReferenceId) {
    console.error("POST /api/billing/webhook ignored a checkout whose reference is not its customer's account.");
    return;
  }
  if (!record) {
    // Only this mark proves that the account was deleted here; a missing record or account proves nothing.
    if (await deps.accounts.isDeletedCustomer(customerId)) return cancelDeleted(event, customerId, deps);
    record = await relink(event, customerId, deps);
    if (!record) return;
  }
  // The record went away while it was read: the account is being deleted.
  if (!(await applyState(event, record, deps)) && (await deps.accounts.isDeletedCustomer(customerId))) await cancelDeleted(event, customerId, deps);
}

/** Applies what Stripe says now with the event's record. False when the billing record is gone. A read that another one overtook is taken again. */
async function applyState(event: BillingEvent, record: BillingRecord, deps: Deps): Promise<boolean> {
  let known = record;
  for (let attempt = 0; attempt < APPLY_ATTEMPTS; attempt++) {
    const { observed } = await readStripe(deps, known);
    const applied = await deps.accounts.applyBillingEvent({ id: event.id, type: event.type }, known.customerId, observed);
    if (applied.outcome !== "stale") return applied.outcome !== "unknown";
    known = applied.billing;
  }
  throw new BillingUnavailable("applyBillingEvent", "overtaken");
}

/**
 * The account of this customer was deleted here (a checkout was paid meanwhile, or a step of the deletion
 * was missed): its subscription is cancelled, and no row is created.
 */
async function cancelDeleted(event: BillingEvent, customerId: string, deps: Deps): Promise<void> {
  if (event.type === DELETED) return;
  const cancelled = await deps.billing.cancelSubscriptions(customerId);
  if (cancelled > 0) console.error("POST /api/billing/webhook cancelled the subscription of a deleted account.");
}

/**
 * A customer without a record and without a deletion mark (a restored database, or a record lost another
 * way): bound again only to the account the customer was created for by this Retrofit, which a checkout
 * must also name, which exists, has a profile and has no other customer. Otherwise nothing is changed,
 * and Retrofit's own customers raise an alert for the owner.
 */
async function relink(event: BillingEvent, customerId: string, deps: Deps): Promise<BillingRecord | null> {
  const owner = await deps.billing.customerOwner(customerId);
  if (!owner || owner.origin !== deps.config.publicOrigin || !isUuid(owner.accountId)) return null;
  const named = event.type !== COMPLETED || event.clientReferenceId === owner.accountId;
  if (named && (await deps.auth.getUser(owner.accountId)) !== null) {
    const linked = await deps.accounts.linkBillingCustomer(owner.accountId, customerId);
    if ("billing" in linked && linked.billing.customerId === customerId) return linked.billing;
  }
  console.error("[BILLING_ALERT] POST /api/billing/webhook: a customer of this Retrofit has no billing record and no deletion mark. Nothing was changed. Check it in Stripe.");
  return null;
}
