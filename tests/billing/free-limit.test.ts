import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryAccountData } from "@/lib/accounts/memory";
import { handleAnalyze } from "@/lib/api/analyze";
import { FREE_ANALYSES, FREE_WINDOW_S, networkOf } from "@/lib/billing/free-limit";
import { createMemoryBacking, createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";
import { accountCookie, analyzeRequest, cookieFrom, holdAllSlots, storeDump, type TestDeps } from "../helpers/server-deps";
import { billingDeps, brokenBilling, OWNER, spiedAccounts, START, withBilling } from "./setup";

const LIMIT_TEXT = "You've used your 5 free analyses. Sign in to keep going.";
const DAY_MS = 24 * 3600_000;
const VISITOR = `retrofit_visitor=${"a".repeat(32)}`;
const OTHER_VISITOR = `retrofit_visitor=${"b".repeat(32)}`;

afterEach(() => vi.restoreAllMocks());

async function ready(offsetMs: number, o: Parameters<typeof billingDeps>[1] = {}) {
  const r = billingDeps(offsetMs, { ...o, env: { ANALYSES_PER_CLIENT_HOUR: "1000", ...o.env } });
  await holdAllSlots(r.d, 1_000_000);
  return r;
}
let n = 0;
const analyze = async (d: TestDeps, o: { cookie?: string; ip?: string; url?: string } = {}) => {
  const res = await handleAnalyze(analyzeRequest({ url: o.url ?? `https://site${++n}.example.com` }, { cookie: o.cookie ?? VISITOR, ip: o.ip }), d);
  return { status: res.status, body: (await res.json()) as { error?: string; message?: string; id?: string }, res };
};
const statuses = async (d: TestDeps, count: number, o: Parameters<typeof analyze>[1] = {}) => {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push((await analyze(d, o)).status);
  return out;
};
const FIVE = [200, 200, 200, 200, 200];

describe("the free-analysis limit", () => {
  // Fails if a visitor or a judge meets the limit 1 ms before the start.
  it("does not exist before the start: one anonymous visitor completes six analyses and more", async () => {
    const { d } = await ready(-1);
    expect(await statuses(d, 8)).toEqual(Array(8).fill(200));
    expect(storeDump(d.backing)).not.toContain("free-analyses");
  });

  // Fails if the sixth anonymous analysis runs, its text changes, or a signed-in Free account is stopped (also on the same network).
  it("from the exact instant on, the sixth anonymous analysis gets the sign-in prompt, and a signed-in Free account continues", async () => {
    const { d } = await ready(0);
    expect(await statuses(d, FREE_ANALYSES)).toEqual(FIVE);
    const sixth = await analyze(d);
    expect(sixth.status).toBe(403);
    expect(sixth.body).toEqual({ error: "free_limit", message: LIMIT_TEXT });
    const account = `${VISITOR}; ${await accountCookie(d)}`;
    expect(await statuses(d, 7, { cookie: account })).toEqual(Array(7).fill(200));
    expect((await analyze(d)).status).toBe(403);
  });

  // Fails if analyses from before the start use up the free ones.
  it("analyses before the start do not count", async () => {
    const { d, clock } = await ready(-1);
    expect(await statuses(d, 6)).toEqual(Array(6).fill(200));
    clock.set(START);
    expect(await statuses(d, 6)).toEqual([...FIVE, 403]);
  });

  // Fails if clearing the cookie, or moving to another network, gives more than five.
  it("counts per visitor cookie and per network", async () => {
    const { d } = await ready(0);
    expect(await statuses(d, 6, { ip: undefined, cookie: "" })).toEqual([...FIVE, 403]);
    const { d: e } = await ready(0);
    const out: number[] = [];
    for (let i = 0; i < 6; i++) out.push((await analyze(e, { ip: `198.51.100.${i}` })).status);
    expect(out).toEqual([...FIVE, 403]);
    expect((await analyze(e, { ip: "198.51.100.77", cookie: OTHER_VISITOR })).status).toBe(200);
  });

  // Fails if a refused request on a full network uses up the visitor's own count, or the reverse.
  it("a refusal by one count leaves the other as it was", async () => {
    const { d } = await ready(0);
    expect(await statuses(d, 5, { cookie: "" })).toEqual(FIVE);
    expect(await statuses(d, 3)).toEqual([403, 403, 403]);
    expect(await statuses(d, 6, { ip: "198.51.100.20" })).toEqual([...FIVE, 403]);
  });

  // Fails if parallel requests pass five together.
  it("twelve parallel requests start exactly five", async () => {
    const { d } = await ready(0);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => analyze(d, { url: `https://parallel${i}.example.com` })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(FREE_ANALYSES);
    expect(results.filter((r) => r.status === 403)).toHaveLength(12 - FREE_ANALYSES);
    expect((await analyze(d)).status).toBe(403);
  });

  // Fails if joining another visitor's crawl, or a cached one, is free of the count.
  it("a joined analysis counts like any start", async () => {
    const { d } = await ready(0);
    expect(await statuses(d, 6, { url: "https://same.example.com" })).toEqual([...FIVE, 403]);
  });

  // Review nit. Fails if a visitor whose own count is full takes places of the network while being refused, so that another visitor of
  // the network below the limit is refused.
  it("parallel refused starts of one visitor never refuse another visitor on the network", async () => {
    const { d } = await ready(0);
    // The first visitor is full (its five came from other networks); this network has used one.
    for (let i = 0; i < 5; i++) expect((await analyze(d, { ip: `198.51.100.${i}` })).status).toBe(200);
    for (let round = 0; round < 4; round++) {
      const ip = `203.0.113.${100 + round}`;
      expect(await statuses(d, 4, { cookie: "", ip })).toEqual([200, 200, 200, 200]);
      const results = await Promise.all([analyze(d, { ip }), analyze(d, { ip }), analyze(d, { ip }), analyze(d, { cookie: OTHER_VISITOR, ip }), analyze(d, { ip }), analyze(d, { ip })]);
      expect(results.map((r) => r.status)).toEqual([403, 403, 403, 200, 403, 403]);
    }
  });

  // Review nit. Fails if a place given back by a failed start in the same moment stays lost to the visitor who waits for it.
  it("a place given back while another start is refused is found again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const backing = createMemoryBacking();
    const base = createMemoryStore({ clock: () => START, backing });
    let fail = false;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const store: Store = { ...base, enqueue: async (...a) => { if (fail) { fail = false; await held; throw new Error("queue down"); } return base.enqueue(...a); } };
    const { d } = await ready(0, { store, backing });
    const ip = "203.0.113.200";
    expect(await statuses(d, 4, { cookie: "", ip })).toEqual([200, 200, 200, 200]);
    fail = true;
    // Takes the fifth place, then fails after the next visitor was refused once.
    const failing = analyze(d, { cookie: "", ip, url: "https://failing.example.com" });
    await new Promise((r) => setTimeout(r, 5));
    const waiting = analyze(d, { cookie: OTHER_VISITOR, ip });
    await new Promise((r) => setTimeout(r, 2));
    release();
    expect([(await failing).status, (await waiting).status]).toEqual([503, 200]);
    expect((await analyze(d, { cookie: "", ip })).status).toBe(403);
  });

  // P5-R13. Fails if an IPv6 visitor gets a new count with each address of the home's /64, or two homes share one; IPv4 stays exact.
  it("an IPv6 network is its /64", async () => {
    expect(networkOf("2001:db8:1:2:3:4:5:6")).toBe(networkOf("2001:0DB8:0001:0002:ffff::1"));
    expect(networkOf("2001:db8:1:2::1")).not.toBe(networkOf("2001:db8:1:3::1"));
    expect(networkOf("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(networkOf("203.0.113.9")).not.toBe(networkOf("203.0.113.10"));
    expect(networkOf("2001:db8:1:2::1%eth0")).toBe(networkOf("2001:db8:1:2::1"));
    expect([networkOf("unknown"), networkOf("not an address")]).toEqual(["unknown", "not an address"]);
    const { d } = await ready(0);
    const out: number[] = [];
    for (let i = 0; i < 6; i++) out.push((await analyze(d, { cookie: "", ip: `2001:db8:1:2::${i + 1}` })).status);
    expect(out).toEqual([...FIVE, 403]);
    expect((await analyze(d, { cookie: "", ip: "2001:db8:1:3::1" })).status).toBe(200);
  });

  // Fails if a start that did not happen uses up a free analysis: a bad address, the hourly cap, the daily cap, an undecided
  // count, a queue failure or a failed analysis write.
  it("a refused or failed start does not count", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refused: [string, (backing: ReturnType<typeof createMemoryBacking>) => { env?: Record<string, string>; store?: (s: Store) => Store }, number, number][] = [
      ["bad address", () => ({}), 400, 5],
      ["daily cap", () => ({ env: { CRAWL_MAX_HOSTS_PER_DAY: "1" } }), 429, 0],
      ["queue", () => ({ store: (s) => ({ ...s, enqueue: async () => { throw new Error("queue down"); } }) }), 503, 0],
      ["write", () => ({ store: (s) => ({ ...s, set: async (key, ...rest) => { if (key.startsWith("analysis:")) throw new Error("write failed"); return s.set(key, ...rest); }, putIfAbsent: async (key, ...rest) => { if (key.startsWith("analysis:")) throw new Error("write failed"); return s.putIfAbsent(key, ...rest); } }) }), 503, 0],
    ];
    for (const [name, make, status] of refused) {
      const backing = createMemoryBacking();
      const o = make(backing);
      const clock = billingDeps(0).clock;
      const store = createMemoryStore({ clock: clock.clock, backing });
      const { d } = await ready(0, { env: o.env, store: o.store ? o.store(store) : store, backing });
      if (name === "daily cap") expect((await analyze(d, { url: "https://first.example.com", cookie: OTHER_VISITOR, ip: "198.51.100.1" })).status).toBe(200);
      for (let i = 0; i < 7; i++) expect((await analyze(d, name === "bad address" ? { url: "https://10.0.0.1" } : {})).status, name).toBe(status);
      // The same Store, healthy again (its crawl slots are still held).
      const healthy = billingDeps(0, { store, backing, env: { ANALYSES_PER_CLIENT_HOUR: "1000" } }).d;
      expect(await statuses(healthy, 6), name).toEqual([...FIVE, 403]);
    }
  });

  // Fails if the hourly cap stops applying, or a request it refuses uses up a free analysis.
  it("the hourly cap stays, and its refusals do not count", async () => {
    const { d, clock } = await ready(0, { env: { ANALYSES_PER_CLIENT_HOUR: "3" } });
    expect(await statuses(d, 5)).toEqual([200, 200, 200, 429, 429]);
    clock.advance(3600_000);
    expect(await statuses(d, 3)).toEqual([200, 200, 403]);
  });

  // Fails if the window is not the documented 30 days from the start, or a new window keeps the old count.
  it("the count is kept for fixed windows of 30 days from the start", async () => {
    expect(FREE_WINDOW_S).toBe(30 * 24 * 3600);
    const { d, clock } = await ready(0);
    expect(await statuses(d, 5)).toEqual(FIVE);
    clock.set(START + 30 * DAY_MS - 1);
    expect((await analyze(d)).status).toBe(403);
    clock.set(START + 30 * DAY_MS);
    expect(await statuses(d, 6)).toEqual([...FIVE, 403]);
  });

  // Fails if a failing counter refuses a visit (billing must never block one).
  it("allows the analysis when the count cannot be read", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const backing = createMemoryBacking();
    const base = createMemoryStore({ clock: () => START, backing });
    const store: Store = { ...base, incrementWindow: async (key, ...rest) => { if (key.startsWith("free-analyses")) throw new Error("down"); return base.incrementWindow(key, ...rest); } };
    const { d } = await ready(0, { store, backing });
    expect(await statuses(d, 7)).toEqual(Array(7).fill(200));
    expect(errors).toHaveBeenCalled();
  });

  // Fails if the long-lived counters hold the address or the visitor cookie.
  it("stores neither the IP address nor the visitor cookie, and answers no cookie change", async () => {
    const { d } = await ready(0);
    const first = await analyze(d, { cookie: "", ip: "203.0.113.99" });
    const dump = storeDump(d.backing);
    expect(dump).toContain("free-analyses");
    expect(dump).not.toContain("203.0.113.99");
    expect(dump).not.toContain(cookieFrom(first.res).split("=")[1]);
    expect((await analyze(d)).res.headers.get("set-cookie")).toBeNull();
  });
});

describe("the analysis start before billing", () => {
  // Fails if the analysis path makes one more Store, account data or Stripe call 1 ms before the start than it made long before
  // it, or asks for another cookie.
  it("makes exactly the calls it made before billing existed, for a visitor and for a signed-in account", async () => {
    const run = async (offsetMs: number, signedIn: boolean) => {
      const ops: string[] = [];
      const spy = spiedAccounts(createMemoryAccountData());
      const { d } = await ready(offsetMs, { accounts: spy.accounts, instrument: (op, key) => void ops.push(`${op} ${key.split(":")[0]}`) });
      const cookie = signedIn ? `${VISITOR}; ${await accountCookie(d)}` : VISITOR;
      ops.length = 0;
      const { res } = await analyze(d, { cookie, url: "https://spy.example.com" });
      await d.settle();
      expect(res.status).toBe(200);
      return { ops: ops.sort(), accounts: spy.calls, stripe: [...d.fixtureBilling.calls], cookie: res.headers.get("set-cookie") };
    };
    for (const signedIn of [false, true]) {
      const before = await run(-1, signedIn);
      expect(before).toEqual(await run(Date.parse("2026-11-23T10:00:00Z") - START, signedIn));
      // One ownership read of a signed-in start (an owner's new read, src/lib/claims/owner.ts), which has nothing to do with billing.
      expect([before.accounts, before.stripe, before.cookie]).toEqual([signedIn ? ["listClaims"] : [], [], null]);
      expect(before.ops.join()).not.toMatch(/free-analyses|account-window|billing/);
    }
    // The spy sees the new calls after the start.
    expect((await run(0, false)).ops.filter((o) => o.startsWith("incrementWindow free-analyses"))).toHaveLength(2);
  });
});

describe("signed-in accounts after the start", () => {
  // P5-R3. Fails if one account can use the shared daily crawl cap, the cap differs by plan from the configuration, an outage of the
  // plan stops analyses, or the cap exists before the start.
  it("the sites an account analyzes per day are capped by plan, never by more than half of the shared cap", async () => {
    const day = async (plan: "free" | "pro" | "agency", env: Record<string, string>, tries: number, offset = 0) => {
      const { d } = await ready(offset, { env });
      if (plan !== "free") await withBilling(d, OWNER, { plan });
      const cookie = await accountCookie(d);
      const out = [];
      for (let i = 0; i < tries; i++) out.push(await analyze(d, { cookie, ip: `198.51.${i % 200}.9` }));
      return { d, ok: out.filter((r) => r.status === 200).length, last: out.at(-1)! };
    };
    const caps = { ACCOUNT_SITES_PER_DAY_FREE: "3", ACCOUNT_SITES_PER_DAY_PRO: "5", ACCOUNT_SITES_PER_DAY_AGENCY: "9" };
    expect((await day("free", caps, 12)).ok).toBe(3);
    expect((await day("pro", caps, 12)).ok).toBe(5);
    expect((await day("agency", caps, 12)).ok).toBe(9);
    expect((await day("free", caps, 12, -600_000)).ok).toBe(12);
    const shared = await day("agency", { CRAWL_MAX_HOSTS_PER_DAY: "10" }, 10);
    expect(shared.ok).toBe(5);
    expect(shared.last.status).toBe(429);
    expect(shared.last.body).toMatchObject({ error: "account_limit", message: "Your account reached today's limit of 5 sites. Try again tomorrow." });
    // The other half is there for everybody else.
    expect(await statuses(shared.d, 5, { cookie: "", ip: "203.0.113.50" })).toEqual(FIVE);
  });

  // Fails if analyzing the same site again uses up another of the day's sites.
  it("a site counts once a day for its account", async () => {
    const { d } = await ready(0, { env: { ACCOUNT_SITES_PER_DAY_FREE: "1" } });
    const cookie = await accountCookie(d);
    expect(await statuses(d, 3, { cookie, url: "https://again.example.com" })).toEqual([200, 200, 200]);
    expect((await analyze(d, { cookie })).status).toBe(429);
  });

  // Fails if a billing outage stops a signed-in visitor's analysis.
  it("an unreadable plan does not stop an analysis", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { d } = await ready(0, { accounts: brokenBilling(createMemoryAccountData()), env: { ACCOUNT_SITES_PER_DAY_FREE: "1", ACCOUNT_SITES_PER_DAY_PRO: "1" } });
    expect(await statuses(d, 3, { cookie: await accountCookie(d) })).toEqual([200, 200, 200]);
  });

  // Fails if one account passes its hourly cap by changing networks, or the cap applies before the start.
  it("the hourly analysis cap also counts per account", async () => {
    const { d } = await ready(0, { env: { ANALYSES_PER_CLIENT_HOUR: "3" } });
    const cookie = await accountCookie(d);
    const out: number[] = [];
    for (let i = 0; i < 4; i++) out.push((await analyze(d, { cookie, ip: `198.51.100.${i}` })).status);
    expect(out).toEqual([200, 200, 200, 429]);
    const { d: e } = await ready(-1, { env: { ANALYSES_PER_CLIENT_HOUR: "3" } });
    const early = await accountCookie(e);
    for (let i = 0; i < 4; i++) expect((await analyze(e, { cookie: early, ip: `198.51.100.${i}` })).status).toBe(200);
  });
});
