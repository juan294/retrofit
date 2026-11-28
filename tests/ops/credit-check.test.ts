import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAlert, overrunAlert, type Alert } from "@/lib/ops/alert";
import { handleCreditCheck, runCreditCheck } from "@/lib/ops/credit-check";
import type { LedgerView } from "@/lib/ops/ledger-view";
import { CRON_SECRET, GITHUB_TOKEN, ISSUES_URL, cronRequest } from "../helpers/ops";
import { storeDump, testDeps, type TestDeps } from "../helpers/server-deps";

const OTARI_KEY = "sk-otari-test-0123456789";

// FREE_CREDIT_USD 10 and JUDGE_RESERVE_USD 3, in micro-USD.
const CREDIT = 10_000_000;
const RESERVE = 3_000_000;

interface Sent {
  url: string;
  headers: Headers;
  body: { title: string; body: string };
}

let sent: Sent[];
let respond: () => Promise<Response>;

/** The network boundary: only api.github.com answers; anything else fails the test. */
function stubGitHub(): void {
  sent = [];
  respond = async () => new Response(JSON.stringify({ number: 1 }), { status: 201 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.github.com/")) throw new Error(`unexpected network call to ${url}`);
      sent.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return respond();
    }),
  );
}

function deps(env: Record<string, string> = {}): TestDeps {
  return testDeps({ env: { CRON_SECRET, ALERT_GITHUB_TOKEN: GITHUB_TOKEN, OTARI_API_KEY: OTARI_KEY, ...env } });
}

function view(usedFraction: number, judgeSpentMicro = 0, outstandingShare = 0.25): LedgerView {
  const used = Math.round(CREDIT * usedFraction);
  const outstanding = Math.round(used * outstandingShare);
  return { totalSpentMicro: used - outstanding, totalOutstandingMicro: outstanding, judgeSpentMicro };
}

beforeEach(stubGitHub);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("billing without Stripe", () => {
  const START = "2027-01-20T00:00:00Z";
  const at = (ms: number, env: Record<string, string> = {}) =>
    testDeps({ clock: () => ms, env: { CRON_SECRET, ALERT_GITHUB_TOKEN: GITHUB_TOKEN, BILLING_START: START, ...env } });
  const STRIPE = { STRIPE_SECRET_KEY: "sk_test_unit_only", STRIPE_WEBHOOK_SECRET: "whsec_unit_only" };

  // Fails if the start of billing without Stripe stays unnoticed (nobody can buy a plan), or the alert comes before it, with Stripe, or twice.
  it("opens one issue from the billing start on, and only without the Stripe variables", async () => {
    const start = Date.parse(START);
    expect(await runCreditCheck(at(start - 1), view(0.1))).toEqual({ alerts: [] });
    expect(await runCreditCheck(at(start, STRIPE), view(0.1))).toEqual({ alerts: [] });
    expect(sent).toHaveLength(0);
    const d = at(start);
    expect(await runCreditCheck(d, view(0.1))).toEqual({ alerts: ["billing-not-configured"] });
    expect(await runCreditCheck(d, view(0.1))).toEqual({ alerts: [] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.body).toContain("STRIPE_SECRET_KEY");
  });
});

describe("credit check", () => {
  // Fails if the check opens an issue before any threshold is crossed.
  it("opens no issue below every threshold", async () => {
    const d = deps();
    expect(await runCreditCheck(d, view(0.49))).toEqual({ alerts: [] });
    expect(sent).toHaveLength(0);
  });

  // Fails if a threshold alert repeats across runs, or a newly crossed threshold is missed.
  it("opens one issue per threshold across repeated runs", async () => {
    // A small reserve keeps the judge alert out of this case: at 99% used, 1% of the credit is the whole reserve.
    const d = deps({ JUDGE_RESERVE_USD: "0.1" });
    expect(await runCreditCheck(d, view(0.55))).toEqual({ alerts: ["threshold:50"] });
    expect(await runCreditCheck(d, view(0.6))).toEqual({ alerts: [] });
    expect(await runCreditCheck(d, view(0.85))).toEqual({ alerts: ["threshold:80"] });
    expect(await runCreditCheck(d, view(0.97))).toEqual({ alerts: ["threshold:95"] });
    expect(await runCreditCheck(d, view(0.99))).toEqual({ alerts: [] });

    expect(sent.map((s) => s.body.title)).toEqual(Array(3).fill("Free AI credit threshold reached"));
    expect(sent.map((s) => s.body.body.split("\n")[0])).toEqual([
      "50% of the free AI credit is used.",
      "80% of the free AI credit is used.",
      "95% of the free AI credit is used.",
    ]);
    for (const s of sent) {
      expect(s.url).toBe(ISSUES_URL);
      expect(s.headers.get("authorization")).toBe(`Bearer ${GITHUB_TOKEN}`);
      expect(s.headers.get("accept")).toBe("application/vnd.github+json");
      expect(s.headers.get("x-github-api-version")).toBe("2022-11-28");
    }
  });

  // Fails if outstanding reservations are left out of the used fraction.
  it("counts outstanding reservations toward the threshold", async () => {
    const d = deps();
    const v: LedgerView = { totalSpentMicro: 3_000_000, totalOutstandingMicro: 2_100_000, judgeSpentMicro: 0 };
    expect(await runCreditCheck(d, v)).toEqual({ alerts: ["threshold:50"] });
    expect(sent[0]?.body.body).toContain("Outstanding reservations: 21% of the credit.");
  });

  // Fails if two thresholds crossed between runs open fewer than two issues.
  it("opens every threshold crossed since the last run", async () => {
    const d = deps();
    expect(await runCreditCheck(d, view(0.9))).toEqual({ alerts: ["threshold:50", "threshold:80"] });
  });

  // Fails if the judge alert fires at 25% or more remaining, or does not fire below 25%.
  it("opens the judge alert once when less than 25% of the reserve remains", async () => {
    const d = deps();
    expect(await runCreditCheck(d, view(0.1, RESERVE * 0.75))).toEqual({ alerts: [] });
    expect(await runCreditCheck(d, view(0.1, RESERVE * 0.76))).toEqual({ alerts: ["judge-reserve-low"] });
    expect(await runCreditCheck(d, view(0.1, RESERVE * 0.9))).toEqual({ alerts: [] });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.title).toBe("Free AI judge reserve low");
    expect(sent[0]?.body.body).toContain("24% of the judge reserve remains.");
  });

  // Fails if public spending past the credit is not seen as eating into the judge reserve.
  it("opens the judge alert when the remaining credit is below 25% of the reserve", async () => {
    const d = deps();
    const v: LedgerView = { totalSpentMicro: CREDIT - RESERVE * 0.2, totalOutstandingMicro: 0, judgeSpentMicro: 0 };
    expect((await runCreditCheck(d, v)).alerts).toContain("judge-reserve-low");
  });

  // Fails if an issue body carries an amount, a key, a token or a secret.
  it("puts only percentages and pool names in issue bodies", async () => {
    const d = deps();
    const v: LedgerView = { totalSpentMicro: 9_123_457, totalOutstandingMicro: 654_321, judgeSpentMicro: 2_876_543 };
    await runCreditCheck(d, v);
    await openAlert(overrunAlert("hold-1"), d);
    expect(sent.length).toBeGreaterThanOrEqual(5);
    const all = sent.map((s) => `${s.body.title}\n${s.body.body}`).join("\n");
    for (const forbidden of [GITHUB_TOKEN, OTARI_KEY, CRON_SECRET, "9123457", "654321", "2876543", "9.12", "0.65", "2.88", "$", "USD"]) {
      expect(all).not.toContain(forbidden);
    }
    expect(all).not.toMatch(/\bsid\b|cookie|session/i);
    // Every number in a threshold or judge body is a percentage.
    for (const s of sent.filter((x) => !x.body.title.includes("overrun"))) {
      expect(s.body.body.replace(/\d+(\.\d)?%/g, "")).not.toMatch(/\d/);
    }
    expect(storeDump(d.backing)).not.toContain(GITHUB_TOKEN);
  });

  // Fails if a failed GitHub request leaves the marker, so the alert is never sent.
  it("retries a failed GitHub request on the next run", async () => {
    const d = deps();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    respond = async () => new Response(JSON.stringify({ message: "Server Error" }), { status: 502 });
    expect(await runCreditCheck(d, view(0.55))).toEqual({ alerts: [] });
    respond = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await runCreditCheck(d, view(0.55))).toEqual({ alerts: [] });
    respond = async () => new Response("{}", { status: 201 });
    expect(await runCreditCheck(d, view(0.55))).toEqual({ alerts: ["threshold:50"] });
    expect(await runCreditCheck(d, view(0.55))).toEqual({ alerts: [] });
    expect(sent).toHaveLength(3);
    const logged = log.mock.calls.flat().join("\n");
    expect(logged).toContain("502");
    expect(logged).not.toContain(GITHUB_TOKEN);
  });

  // Fails if two concurrent callers with one key both reach GitHub.
  it("makes one request for two parallel alerts with one key", async () => {
    const d = deps();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    respond = async () => {
      await gate;
      return new Response("{}", { status: 201 });
    };
    const alert: Alert = { key: "threshold:50", title: "Free AI credit threshold reached", body: "50% of the free AI credit is used." };
    const both = Promise.all([openAlert(alert, d), openAlert(alert, d)]);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    release();
    const results = await both;
    expect(sent).toHaveLength(1);
    expect(results.filter((r) => r.sent)).toHaveLength(1);
  });

  // Fails if the overrun issue lacks the reconciliation steps or the resume command.
  it("lists the reconciliation steps in the overrun alert", async () => {
    const d = deps();
    expect(await openAlert(overrunAlert("hold-1"), d)).toEqual({ sent: true });
    expect(await openAlert(overrunAlert("hold-1"), d)).toMatchObject({ sent: false });
    expect(sent).toHaveLength(1);
    const { title, body } = sent[0]!.body;
    expect(title).toBe("Free AI reservation overrun");
    for (const step of ["bound", "prices", "provider balance", "outstanding reservations"]) expect(body).toContain(step);
    expect(body).toContain("pnpm ops:resume-free --reconciled-balance <usd> --note <text>");
    expect(body).toContain("authorized production action");
  });

  // Fails if a missing token sends a request, stays silent, or blocks a later send.
  it("logs one line and sends nothing without ALERT_GITHUB_TOKEN", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({ ALERT_GITHUB_TOKEN: "" });
    expect(await openAlert(overrunAlert("hold-1"), d)).toEqual({ sent: false });
    expect(sent).toHaveLength(0);
    expect(log.mock.calls).toEqual([["Alert not sent: ALERT_GITHUB_TOKEN is not set"]]);
    const withToken = deps();
    const shared = { ...withToken, store: d.store };
    expect(await openAlert(overrunAlert("hold-1"), shared)).toEqual({ sent: true });
  });
});

describe("GET /api/cron/credit-check", () => {
  const ledger = async () => view(0.55);

  // Fails if the cron route runs without the exact CRON_SECRET.
  it.each([
    ["missing", null],
    ["wrong", "Bearer not-the-secret"],
    ["unprefixed", CRON_SECRET],
    ["prefix of the secret", `Bearer ${CRON_SECRET.slice(0, -1)}`],
  ])("answers 401 with a %s secret", async (_name, auth) => {
    const res = await handleCreditCheck(cronRequest(auth), deps(), ledger);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(sent).toHaveLength(0);
  });

  // Fails if an unset CRON_SECRET lets an empty Bearer through.
  it("answers 401 when CRON_SECRET is not set", async () => {
    const res = await handleCreditCheck(cronRequest("Bearer "), deps({ CRON_SECRET: "" }), ledger);
    expect(res.status).toBe(401);
  });

  // Fails if the route does not run the check or report the opened keys.
  it("runs the check with the right secret", async () => {
    const d = deps();
    const res = await handleCreditCheck(cronRequest(`Bearer ${CRON_SECRET}`), d, ledger);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checked: true, alerts: ["threshold:50"] });
    const again = await handleCreditCheck(cronRequest(`Bearer ${CRON_SECRET}`), d, ledger);
    expect(await again.json()).toEqual({ checked: true, alerts: [] });
  });

  // Fails if an unreadable ledger is reported as a successful check.
  it("answers 503 when the ledger is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleCreditCheck(cronRequest(`Bearer ${CRON_SECRET}`), deps(), async () => {
      throw new Error("ledger not wired");
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});
