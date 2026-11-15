import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHold, holdId } from "@/lib/inference/hold";
import { counterDepsOf, createLedger } from "@/lib/inference/ledger";
import { alertStoreKey, openAlert, overrunAlert } from "@/lib/ops/alert";
import { handleCreditCheck } from "@/lib/ops/credit-check";
import { ledgerViewFor } from "@/lib/ops/ledger-view";
import { CRON_SECRET, GITHUB_TOKEN, ISSUES_URL, cronRequest } from "../helpers/ops";
import { fakeClock, testDeps } from "../helpers/server-deps";

let titles: string[];
let respond: (signal: AbortSignal | null) => Promise<Response>;

beforeEach(() => {
  titles = [];
  respond = async () => new Response("{}", { status: 201 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== ISSUES_URL) throw new Error(`unexpected network call to ${String(input)}`);
      const res = await respond(init?.signal ?? null);
      if (res.ok) titles.push((JSON.parse(String(init?.body)) as { title: string }).title);
      return res;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup() {
  const clock = fakeClock();
  const d = testDeps({ clock: clock.clock, env: { CRON_SECRET, ALERT_GITHUB_TOKEN: GITHUB_TOKEN } });
  const counterDeps = counterDepsOf(d);
  return { d, clock, hold: createHold(counterDeps), ledger: createLedger(counterDeps) };
}

describe("overrun alert retry by the daily credit check (P6-R2)", () => {
  // Fails if the cron does not open the overrun alert while a hold exists, or opens it twice.
  it("opens the overrun issue after the proxy's first GitHub request failed, once", async () => {
    const { d, hold } = setup();
    await hold.writeHold({ reason: "reservation_overrun", overrunMicroUsd: 10, reservationMicroUsd: 100 });
    const record = (await hold.read())!;
    respond = async () => new Response('{"message":"Server Error"}', { status: 500 });
    expect(await openAlert(overrunAlert(holdId(record)), { config: d.config, store: d.store })).toEqual({ sent: false });
    expect(titles).toEqual([]);

    respond = async () => new Response("{}", { status: 201 });
    const first = await handleCreditCheck(cronRequest(), d);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { alerts: string[] }).alerts).toEqual([`overrun:${holdId(record)}`]);
    expect(titles).toEqual(["Free AI reservation overrun"]);
    expect(await d.store.get(alertStoreKey(`overrun:${holdId(record)}`))).toEqual({ state: "sent" });

    await handleCreditCheck(cronRequest(), d);
    expect(titles).toEqual(["Free AI reservation overrun"]);
  });

  // Fails if a pool closed by the ledger flag alone (the hold record write never ran) gets no issue.
  it("alerts for a ledger hold flag with no hold record", async () => {
    const { d, ledger } = setup();
    await ledger.raiseHold();
    const view = await ledgerViewFor(d);
    expect(view.holdId).toBe("unrecorded-2026-11-15");
    await handleCreditCheck(cronRequest(), d);
    expect(titles).toEqual(["Free AI reservation overrun"]);
  });

  // Fails if the cron opens an overrun issue with no hold.
  it("opens no overrun issue without a hold", async () => {
    const { d } = setup();
    expect((await ledgerViewFor(d)).holdId).toBeNull();
    await handleCreditCheck(cronRequest(), d);
    expect(titles).toEqual([]);
  });
});

describe("openAlert timeout (P6-R7)", () => {
  // Fails if openAlert ignores timeoutMs (it would wait for the 10 s default and the test would time out).
  it("gives up after timeoutMs and frees the marker for a retry", async () => {
    const { d } = setup();
    respond = (signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const started = Date.now();
    expect(await openAlert(overrunAlert("1"), { config: d.config, store: d.store }, { timeoutMs: 30 })).toEqual({ sent: false });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await d.store.get(alertStoreKey("overrun:1"))).toBeNull();
  });
});
