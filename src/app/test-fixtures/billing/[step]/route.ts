import { getFixtureBilling } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

const page = (title: string, links: readonly (readonly [href: string, text: string])[]) =>
  new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${links.map(([href, text]) => `<p><a href="${href}">${text}</a></p>`).join("")}</main></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
const found = (location: string) => new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

/**
 * Fixtures mode only (404 otherwise): the fixtures gateway's hosted pages. GET checkout?session=<id>
 * offers to pay or cancel and redirects back, as Stripe's page does; GET portal links back to the account.
 */
export async function GET(request: Request, { params }: { params: Promise<{ step: string }> }): Promise<Response> {
  const billing = getFixtureBilling();
  if (!billing) return new Response("Not found", { status: 404 });
  const { step } = await params;
  const query = new URL(request.url).searchParams;
  if (step === "portal") return page("Fixture billing portal", [["/account", "Back to Retrofit"]]);
  const session = step === "checkout" ? billing.session(query.get("session") ?? "") : null;
  if (!session || session.status !== "open") return new Response("Not found", { status: 404 });
  const choice = query.get("do");
  if (choice === "cancel") return found(session.cancelUrl);
  if (choice === "pay") return found(billing.complete(session.id) ?? session.cancelUrl);
  const self = `/test-fixtures/billing/checkout?session=${session.id}`;
  return page("Fixture checkout", [[`${self}&amp;do=pay`, "Pay"], [`${self}&amp;do=cancel`, "Cancel"]]);
}
