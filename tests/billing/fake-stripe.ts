/**
 * An in-memory Stripe API behind a fetch function, for the real adapter's tests (src/lib/billing/stripe.ts):
 * only the endpoints and rules the adapter uses (idempotency keys, open checkout sessions, subscription
 * lists). Any other host or path throws, so no test can contact Stripe.
 */
import { randomUUID } from "node:crypto";

export interface StripeCall {
  readonly method: string;
  readonly path: string;
  readonly params: URLSearchParams;
  readonly headers: Headers;
}

interface Session {
  id: string;
  customer: string;
  status: "open" | "complete" | "expired";
  url: string;
  created: number;
  params: URLSearchParams;
}

interface Sub {
  id: string;
  customer: string;
  status: string;
  price: string;
  created: number;
  cancelAtPeriodEnd: boolean;
  cancelAt?: number;
}

export const PERIOD_END_S = Date.UTC(2027, 2, 1) / 1000;

export function createFakeStripe() {
  const calls: StripeCall[] = [];
  const customers = new Map<string, { deleted: boolean; params: URLSearchParams }>();
  const sessions = new Map<string, Session>();
  const subs = new Map<string, Sub>();
  const replies = new Map<string, { status: number; body: unknown; params: string }>();
  const prices = new Map<string, Record<string, unknown>>();
  let failure: ((call: StripeCall) => Response | Error | null) | null = null;
  let n = 0;

  const id = (prefix: string) => `${prefix}_test_${++n}${randomUUID().slice(0, 4)}`;
  const error = (status: number, code: string, message = "fake error") => ({ status, body: { error: { type: "invalid_request_error", code, message } } });
  const list = (data: unknown[]) => ({ status: 200, body: { object: "list", data, has_more: false, url: "/v1/list" } });
  const subBody = (s: Sub) => ({
    id: s.id,
    object: "subscription",
    customer: s.customer,
    status: s.status,
    created: s.created,
    cancel_at_period_end: s.cancelAtPeriodEnd,
    cancel_at: s.cancelAt ?? null,
    livemode: false,
    items: { object: "list", data: [{ id: `si_${s.id}`, object: "subscription_item", current_period_end: PERIOD_END_S, price: { id: s.price, object: "price" } }], has_more: false, url: "" },
  });
  const sessionBody = (s: Session) => ({ id: s.id, object: "checkout.session", created: s.created, customer: s.customer, status: s.status, url: s.status === "open" ? s.url : null, mode: s.params.get("mode"), metadata: Object.fromEntries([...s.params].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])), client_reference_id: s.params.get("client_reference_id") });

  function route(call: StripeCall): { status: number; body: unknown } {
    const { method, path, params } = call;
    const seg = path.split("/").slice(2);
    if (method === "POST" && path === "/v1/customers") {
      const cus = id("cus");
      customers.set(cus, { deleted: false, params });
      return { status: 200, body: { id: cus, object: "customer" } };
    }
    if (method === "GET" && seg[0] === "customers" && seg[1]) {
      const c = customers.get(seg[1]);
      if (!c) return error(404, "resource_missing");
      if (c.deleted) return { status: 200, body: { id: seg[1], object: "customer", deleted: true } };
      return { status: 200, body: { id: seg[1], object: "customer", metadata: Object.fromEntries([...c.params].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])) } };
    }
    if (method === "GET" && path === "/v1/checkout/sessions") return list([...sessions.values()].filter((s) => s.customer === params.get("customer") && s.status === params.get("status")).map(sessionBody));
    if (method === "POST" && path === "/v1/checkout/sessions") {
      const customer = params.get("customer") ?? "";
      if (!customers.has(customer)) return error(400, "resource_missing");
      const cs = id("cs");
      const s: Session = { id: cs, customer, status: "open", url: `https://checkout.stripe.com/c/pay/${cs}`, created: n, params };
      sessions.set(cs, s);
      return { status: 200, body: sessionBody(s) };
    }
    if (seg[0] === "checkout" && seg[1] === "sessions" && seg[2]) {
      const s = sessions.get(seg[2]);
      if (!s) return error(404, "resource_missing");
      if (method === "POST" && seg[3] === "expire") {
        if (s.status !== "open") return error(400, "checkout_session_not_open");
        s.status = "expired";
      }
      return { status: 200, body: sessionBody(s) };
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions") return { status: 200, body: { id: id("bps"), object: "billing_portal.session", url: `https://billing.stripe.com/p/session/${params.get("customer")}` } };
    if (method === "GET" && path === "/v1/subscriptions") {
      const customer = params.get("customer") ?? "";
      if (!customers.has(customer) || customers.get(customer)?.deleted) return error(400, "resource_missing");
      return list([...subs.values()].filter((s) => s.customer === customer && (params.get("status") === "all" || s.status !== "canceled")).map(subBody));
    }
    if (method === "DELETE" && seg[0] === "subscriptions" && seg[1]) {
      const s = subs.get(seg[1]);
      if (!s || s.status === "canceled") return error(404, "resource_missing");
      s.status = "canceled";
      return { status: 200, body: subBody(s) };
    }
    if (method === "GET" && seg[0] === "prices" && seg[1]) return prices.has(seg[1]) ? { status: 200, body: prices.get(seg[1]) } : error(404, "resource_missing");
    throw new Error(`fake Stripe: unexpected ${method} ${path}`);
  }

  const fakeFetch: typeof fetch = async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.origin !== "https://api.stripe.com") throw new Error(`fake Stripe: refused ${url.origin}`);
    const body = req.method === "GET" ? url.searchParams : new URLSearchParams(await req.text());
    const call: StripeCall = { method: req.method, path: url.pathname, params: body, headers: req.headers };
    calls.push(call);
    const failed = failure?.(call);
    if (failed instanceof Error) throw failed;
    if (failed) return failed;
    const key = req.headers.get("idempotency-key");
    const kept = key && req.method === "POST" ? replies.get(key) : undefined;
    const headers = { "content-type": "application/json", "request-id": "req_1" };
    if (kept) {
      if (kept.params !== body.toString()) return new Response(JSON.stringify({ error: { type: "idempotency_error", message: "keys" } }), { status: 400, headers });
      return new Response(JSON.stringify(kept.body), { status: kept.status, headers: { ...headers, "idempotent-replayed": "true" } });
    }
    const r = route(call);
    if (key && req.method === "POST") replies.set(key, { ...r, params: body.toString() });
    return new Response(JSON.stringify(r.body), { status: r.status, headers });
  };

  return {
    fetch: fakeFetch,
    calls,
    customers,
    sessions,
    /** Pays the open checkout session at `url`: an active subscription for its price. */
    pay(url: string, status = "active"): string {
      const s = [...sessions.values()].find((x) => x.url === url);
      if (!s || s.status !== "open") throw new Error("session is not open");
      s.status = "complete";
      return this.subscribe(s.customer, s.params.get("line_items[0][price]") ?? "", status);
    },
    subscribe(customer: string, price: string, status = "active"): string {
      const sub: Sub = { id: id("sub"), customer, status, price, created: ++n, cancelAtPeriodEnd: false };
      subs.set(sub.id, sub);
      return sub.id;
    },
    setSubscription(subId: string, change: Partial<Sub>): void {
      Object.assign(subs.get(subId)!, change);
    },
    setPrice(priceId: string, body: Record<string, unknown>): void {
      prices.set(priceId, { id: priceId, object: "price", ...body });
    },
    deleteCustomer(customer: string): void {
      customers.get(customer)!.deleted = true;
      for (const s of subs.values()) if (s.customer === customer) s.status = "canceled";
    },
    fail(how: ((call: StripeCall) => Response | Error | null) | null): void {
      failure = how;
    },
  };
}
