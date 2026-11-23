import { beforeDeadline, TIMED_OUT } from "@/lib/fetch/timers";
import type { ServerDeps } from "@/lib/server/runtime";
import type { BillingGateway, PriceAmount } from "./gateway";
import type { PaidPlanId } from "./plans";
import { logBillingFailure } from "./sync";

/** An amount read from Stripe is shown this long before it is read again. */
const KEEP_MS = 3_600_000;
/** After a failed or slow read, the page shows no amount and asks again this much later. */
const RETRY_MS = 60_000;
const WAIT_MS = 2_000;

interface Cached {
  /** What the page shows until `until`; null: no amount. */
  text: string | null;
  until: number;
  /** The read in progress, shared by every view. */
  reading: Promise<string | null> | null;
}

// Per gateway, so per process (and per test). Amounts are public; nothing here belongs to a visitor.
const caches = new WeakMap<BillingGateway, Map<string, Cached>>();

/** "$11.00 per month"; null for a currency the runtime cannot format. */
export function formatAmount({ amount, currency, interval }: PriceAmount): string | null {
  try {
    const format = new Intl.NumberFormat("en-US", { style: "currency", currency });
    const text = format.format(amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
    return interval ? `${text} per ${interval}` : text;
  } catch {
    return null;
  }
}

/** The amount of each paid plan that has a price, read from Stripe (cached). A plan is left out while it has none or Stripe cannot be asked. */
export async function planAmounts(deps: Pick<ServerDeps, "config" | "clock" | "billing">, waitMs = WAIT_MS): Promise<Partial<Record<PaidPlanId, string>>> {
  // The price for sale: the first of each plan.
  const prices = Object.entries(deps.config.billing?.prices ?? {}).map(([plan, ids]) => [plan as PaidPlanId, ids[0]!] as const);
  if (prices.length === 0) return {};
  const { billing } = deps;
  const cache = caches.get(billing) ?? new Map<string, Cached>();
  caches.set(billing, cache);

  /** One read of the price, kept when it ends, also when no view waits for it any more. */
  async function read(entry: Cached, priceId: string): Promise<string | null> {
    try {
      const price = await billing.getPrice(priceId);
      Object.assign(entry, { text: price && formatAmount(price), until: deps.clock() + KEEP_MS });
    } catch (e) {
      logBillingFailure("Reading a price", e);
      Object.assign(entry, { text: null, until: deps.clock() + RETRY_MS });
    }
    entry.reading = null;
    return entry.text;
  }

  async function textOf(priceId: string): Promise<string | null> {
    const entry = cache.get(priceId) ?? { text: null, until: 0, reading: null };
    cache.set(priceId, entry);
    if (deps.clock() < entry.until) return entry.text;
    entry.reading ??= read(entry, priceId);
    const text = await beforeDeadline(entry.reading, waitMs);
    if (text !== TIMED_OUT) return text;
    // No amount for now; the read goes on and is kept.
    Object.assign(entry, { text: null, until: deps.clock() + RETRY_MS });
    return null;
  }

  const texts = await Promise.all(prices.map(async ([plan, priceId]) => [plan, await textOf(priceId)] as const));
  return Object.fromEntries(texts.filter(([, text]) => text !== null));
}

export interface PlanOffer {
  readonly amount: string | null;
  /** The Upgrade button shows: billing started and the amount is on the page. */
  readonly upgrade: boolean;
  /** The plan has a price that could not be read: the page says so. */
  readonly unavailable: boolean;
}

/** What /pricing shows for one paid plan. Nobody is offered a plan without seeing what it costs. */
export function planOffer(o: { readonly started: boolean; readonly priced: boolean; readonly amount: string | undefined }): PlanOffer {
  return { amount: o.amount ?? null, upgrade: o.started && o.amount !== undefined, unavailable: o.started && o.priced && o.amount === undefined };
}
