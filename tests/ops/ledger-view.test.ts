import { afterEach, describe, expect, it, vi } from "vitest";
import { createLedger } from "@/lib/inference/ledger";
import { handleCreditCheck } from "@/lib/ops/credit-check";
import { ledgerViewFor } from "@/lib/ops/ledger-view";
import { PUBLIC_ORIGIN, testDeps } from "../helpers/server-deps";

const CRON_SECRET = "cron-secret-0123456789abcdef";
const GITHUB_TOKEN = "ghp_testtoken0123456789ABCDEFGHIJ";
const ISSUES_URL = "https://api.github.com/repos/juan294/retrofit/issues";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup() {
  const d = testDeps({ env: { CRON_SECRET, ALERT_GITHUB_TOKEN: GITHUB_TOKEN } });
  return { d, ledger: createLedger({ store: d.store, config: d.config.free, clock: d.clock }) };
}

describe("ledgerViewFor", () => {
  // Fails if the view is not read from the ledger, or mixes pools or outstanding reservations into spend.
  it("reads spend, outstanding reservations and judge spend from the ledger", async () => {
    const { d, ledger } = setup();
    const p = await ledger.reserve({ pool: "public", sid: "p", microUsd: 5000 });
    const j = await ledger.reserve({ pool: "judge", sid: "j", microUsd: 3000 });
    await ledger.reserve({ pool: "public", sid: "q", microUsd: 700 });
    if (!p.ok || !j.ok) throw new Error("refused");
    await ledger.reconcile(p.reservationId, 4000);
    await ledger.reconcile(j.reservationId, 2500);
    expect(await ledgerViewFor(d)).toEqual({ totalSpentMicro: 6500, totalOutstandingMicro: 700, judgeSpentMicro: 2500 });
  });

  // Fails if the cron route still answers 503 because the view is not wired to the ledger.
  it("lets the credit-check route read the ledger (200, and the 50% alert when half the credit is used)", async () => {
    const { d, ledger } = setup();
    const titles: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) !== ISSUES_URL) throw new Error(`unexpected network call to ${String(input)}`);
        titles.push((JSON.parse(String(init?.body)) as { title: string }).title);
        return new Response("{}", { status: 201 });
      }),
    );
    // Credit 10 USD: one reservation reported at 5.5 USD (an overrun, charged as reported) crosses 50%.
    const r = await ledger.reserve({ pool: "public", sid: "p", microUsd: 1000 });
    if (!r.ok) throw new Error(`refused ${r.reason}`);
    await ledger.reconcile(r.reservationId, 5_500_000);
    const res = await handleCreditCheck(new Request(`${PUBLIC_ORIGIN}/api/cron/credit-check`, { headers: { authorization: `Bearer ${CRON_SECRET}` } }), d);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { alerts: string[] }).alerts).toContain("threshold:50");
    expect(titles).toContain("Free AI credit threshold reached");
  });
});
