import type { ServerDeps } from "@/lib/server/runtime";
import type { BillingGateway, PriceAmount } from "./gateway";
import type { PaidPlanId } from "./plans";
import { logBillingFailure } from "./sync";
import { withTimeout } from "./timeout";

/** An amount read from Stripe is shown this long before it is read again. */
const KEEP_MS = 3_600_000;
/** After a failed or slow read, the page shows no amount and asks again this much later. */
const RETRY_MS = 60_000;
const WAIT_MS = 2_000;

interface Cached {
  readonly text: string | null;
  readonly until: number;
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

  async function textOf(priceId: string): Promise<string | null> {
    const cached = cache.get(priceId);
    if (cached && deps.clock() < cached.until) return cached.text;
    const read = await withTimeout(
      billing.getPrice(priceId).then(
        (price) => ({ text: price && formatAmount(price) }),
        (e: unknown) => {
          logBillingFailure("Reading a price", e);
          return null;
        },
      ),
      waitMs,
    );
    const entry = read ? { text: read.text, until: deps.clock() + KEEP_MS } : { text: null, until: deps.clock() + RETRY_MS };
    cache.set(priceId, entry);
    return entry.text;
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
