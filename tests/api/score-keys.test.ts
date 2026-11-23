import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryAccountData } from "@/lib/accounts/memory";
import { MAX_API_KEYS } from "@/lib/accounts/data";
import { handleCreateKey, handleRevokeKey } from "@/lib/api/api-keys";
import { handleScore, handleScoreOptions } from "@/lib/api/score";
import { agentTexts } from "@/lib/analysis/texts";
import { planOf } from "@/lib/billing/plans";
import { API_KEY_TEXT } from "@/lib/site/billing-texts";
import { PLAN_TEXT } from "@/lib/site/plan-texts";
import { sha256Hex } from "@/lib/security/tokens";
import { billingDeps, brokenBilling, OWNER, spiedAccounts, withBilling } from "../billing/setup";
import { accountCookie, captureConsole, holdAllSlots, OTHER_ACCOUNT, postRequest, scoreRequest, storeDump, type TestDeps, type TestDepsOptions } from "../helpers/server-deps";

const lines: string[] = [];
beforeEach(() => {
  lines.length = 0;
  captureConsole(lines);
});
afterEach(() => vi.restoreAllMocks());

async function setup(offsetMs = 0, o: TestDepsOptions = {}) {
  const r = billingDeps(offsetMs, { ...o, env: { SCORE_WAIT_MS: "1", ANALYSES_PER_CLIENT_HOUR: "3", ...o.env } });
  await holdAllSlots(r.d, 1_000_000);
  return { ...r, cookie: await accountCookie(r.d) };
}
const create = async (d: TestDeps, cookie: string, o = {}) => {
  const res = await handleCreateKey(postRequest("/api/account/keys", {}, { cookie, ...o }), d);
  return { status: res.status, body: (await res.json()) as { key?: string; apiKey?: { id: string; hint: string }; error?: string; message?: string } };
};
const revoke = (d: TestDeps, cookie: string, keyId: unknown) => handleRevokeKey(postRequest("/api/account/keys/revoke", { keyId }, { cookie }), d);
let n = 0;
const score = async (d: TestDeps, auth?: string, o: { ip?: string; url?: string } = {}) => {
  const res = await handleScore(scoreRequest(`?url=${encodeURIComponent(o.url ?? `https://k${++n}.example.com`)}`, { auth, ip: o.ip }), d);
  return { status: res.status, headers: res.headers, body: (await res.json()) as { error?: string; message?: string; status?: string } };
};
const accepted = async (d: TestDeps, auth: string | undefined, tries: number, o = {}) => {
  let ok = 0;
  for (let i = 0; i < tries; i++) if ((await score(d, auth, o)).status === 202) ok++;
  return ok;
};

describe("creating and revoking API keys", () => {
  // Fails if the key is not shown exactly once, is stored or logged raw, or the list reveals it.
  it("shows a new key once and stores only its hash and last four characters", async () => {
    const { d, cookie } = await setup();
    await withBilling(d, OWNER);
    const { status, body } = await create(d, cookie);
    expect(status).toBe(201);
    expect(body.key).toMatch(/^rk_retrofit_[0-9a-f]{32}$/);
    const key = body.key as string;
    expect(body.apiKey).toEqual({ id: expect.any(String), hint: key.slice(-4), createdOn: "19 January 2027" });
    expect(body.message).toBe(API_KEY_TEXT.created);
    expect((await d.accounts.listApiKeys(OWNER)).map((k) => k.id)).toEqual([body.apiKey?.id]);
    const stored = JSON.stringify([...d.accountsBacking.apiKeys.values()]);
    expect(stored).toContain(sha256Hex(key));
    for (const dump of [stored, storeDump(d.backing), lines.join("\n")]) expect(dump).not.toContain(key);
  });

  // Fails if a key is created from another site, signed out, on a Free plan after the start, past the limit, or while the plan is unreadable.
  it("refuses another site, a signed-out visitor, a Free account, an unreadable plan and a sixth key", async () => {
    const { d, cookie } = await setup();
    expect((await create(d, cookie, { fetchSite: "cross-site", origin: "https://evil.example" })).status).toBe(403);
    expect(await create(d, "")).toMatchObject({ status: 401, body: { error: "signed_out" } });
    expect(await create(d, cookie)).toMatchObject({ status: 403, body: { error: "plan_required", message: PLAN_TEXT.required.api_keys } });
    await withBilling(d, OWNER);
    for (let i = 0; i < MAX_API_KEYS; i++) expect((await create(d, cookie)).status).toBe(201);
    expect(await create(d, cookie)).toMatchObject({ status: 409, body: { error: "full", message: API_KEY_TEXT.full } });
    expect(await d.accounts.listApiKeys(OWNER)).toHaveLength(MAX_API_KEYS);
    const broken = await setup(0, { accounts: brokenBilling(createMemoryAccountData()) });
    expect(await create(broken.d, broken.cookie)).toMatchObject({ status: 503, body: { error: "billing_unavailable" } });
  });

  // Fails if creating keys in a loop is not limited, or every signed-in account cannot create one before the start.
  it("limits creations per hour, and needs no plan before the start", async () => {
    const { d, cookie } = await setup(-1);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const r = await create(d, cookie);
      statuses.push(r.status);
      if (r.body.apiKey) await revoke(d, cookie, r.body.apiKey.id);
    }
    expect(statuses).toEqual([...Array<number>(20).fill(201), 429]);
  });

  // Fails if another account revokes a key, or a revoke says nothing happened.
  it("revokes only the account's own key", async () => {
    const { d, cookie } = await setup(-1);
    const { body } = await create(d, cookie);
    const other = await accountCookie(d, OTHER_ACCOUNT);
    for (const [who, id, status] of [[other, body.apiKey?.id, 404], [cookie, "nope", 404], [cookie, 7, 404], ["", body.apiKey?.id, 401], [cookie, body.apiKey?.id, 200], [cookie, body.apiKey?.id, 404]] as const) {
      expect((await revoke(d, who, id)).status).toBe(status);
    }
  });
});

describe("GET /api/score with an API key", () => {
  // Fails if a key keeps the anonymous limit, or the limit is per key or per network instead of per account.
  it("applies the plan's hourly limit per account, not per key or network", async () => {
    const { d, cookie } = await setup();
    await withBilling(d, OWNER);
    const limit = planOf("pro").limits.scoresPerHour as number;
    const keys = [(await create(d, cookie)).body.key, (await create(d, cookie)).body.key];
    let ok = 0;
    for (let i = 0; i < limit + 5; i++) if ((await score(d, `Bearer ${keys[i % 2]}`, { ip: `198.51.100.${i % 7}` })).status === 202) ok++;
    expect(ok).toBe(limit);
    const over = await score(d, `Bearer ${keys[0]}`);
    expect(over).toMatchObject({ status: 429, body: { error: "client_limit" } });
    expect(over.body.message).toContain(`limit of ${limit} site scores per hour`);
    // The anonymous callers of those networks keep their own count.
    expect(await accepted(d, undefined, 5)).toBe(3);
  });

  // Fails if Agency has no higher limit than Pro, or plans.ts and the score route disagree.
  it("gives Agency its higher limit", async () => {
    const { d, cookie } = await setup();
    await withBilling(d, OWNER, { plan: "agency" });
    const limit = planOf("agency").limits.scoresPerHour as number;
    expect(limit).toBeGreaterThan(planOf("pro").limits.scoresPerHour as number);
    const { key } = (await create(d, cookie)).body;
    expect(await accepted(d, `Bearer ${key}`, limit + 1)).toBe(limit);
  });

  // P5-R3. Fails if a key gives anybody new capacity before the start: more than its network has as an anonymous caller, or more by
  // changing networks or keys (the crawl capacity belongs to everybody, judges included).
  it("before the start a key counts against the network exactly as an anonymous call, and also per account", async () => {
    const { d, cookie } = await setup(-600_000);
    const { key } = (await create(d, cookie)).body;
    expect(await accepted(d, undefined, 2)).toBe(2);
    // One place is left for this network, with or without a key.
    expect(await accepted(d, `Bearer ${key}`, 4)).toBe(1);
    expect(await accepted(d, undefined, 2)).toBe(0);
    // Other networks do not give the account more than its own window.
    expect(await accepted(d, `Bearer ${key}`, 6, { ip: "198.51.100.50" })).toBe(2);
    expect(await accepted(d, `Bearer ${key}`, 2, { ip: "198.51.100.51" })).toBe(0);
    expect(await accepted(d, undefined, 5, { ip: "198.51.100.52" })).toBe(3);
  });

  // Fails if a revoked, unknown or malformed key runs a score (also as anonymous), or the answer has no way out.
  it.each([
    ["an unknown key", `Bearer rk_retrofit_${"0".repeat(32)}`],
    ["a short key", "Bearer rk_retrofit_0"],
    ["another product's restricted key", "Bearer rk_live_51abc"],
    ["a key prefix alone", "Bearer rk_"],
    ["a lower-case scheme", `bearer rk_retrofit_${"0".repeat(32)}`],
    ["a key without its scheme", `rk_retrofit_${"0".repeat(32)}`],
    ["two keys", `Bearer rk_retrofit_${"0".repeat(32)} rk_retrofit_${"1".repeat(32)}`],
  ])("refuses %s with 401 and starts nothing", async (_name, auth) => {
    const { d } = await setup();
    const r = await score(d, auth, { url: "https://refused.example.com" });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ status: "error", error: "invalid_key", message: agentTexts.invalid_key });
    expect(r.headers.get("www-authenticate")).toBe("Bearer");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(storeDump(d.backing)).not.toContain("crawl-job:");
    expect([...d.backing.windows.keys()].filter((k) => k.startsWith("client-"))).toEqual([]);
  });

  it("refuses a revoked key with the recovery text", async () => {
    const { d, cookie } = await setup();
    await withBilling(d, OWNER);
    const { body } = await create(d, cookie);
    expect((await score(d, `Bearer ${body.key}`)).status).toBe(202);
    expect((await revoke(d, cookie, body.apiKey?.id)).status).toBe(200);
    const r = await score(d, `Bearer ${body.key}`);
    expect([r.status, r.body.error]).toEqual([401, "invalid_key"]);
    expect(r.body.message).toContain("call again without the Authorization header");
  });

  // Fails if a key whose plan ended keeps its limit, or silently becomes an anonymous call.
  it("refuses a key whose account's plan ended with 403 and says how to go on", async () => {
    const { d, cookie } = await setup();
    const customer = await withBilling(d, OWNER);
    const { key } = (await create(d, cookie)).body;
    await d.accounts.applyBillingState(customer, { plan: "pro", status: "canceled", currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionId: null, unpaidSince: null, observedAt: new Date(d.clock() + 1).toISOString() });
    const r = await score(d, `Bearer ${key}`);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ status: "error", error: "plan_required", message: agentTexts.plan_required });
    expect([...d.backing.windows.keys()].filter((k) => k.startsWith("client-"))).toEqual([]);
  });

  // Fails if a billing outage stops a valid key (a visit), gives it the plan limit, or an unreadable key store falls through to anonymous.
  it("allows the anonymous limit when the plan is unreadable, and answers 503 when the key is", async () => {
    const data = createMemoryAccountData();
    const healthy = await setup(0, { accounts: data });
    await withBilling(healthy.d, OWNER);
    const { key } = (await create(healthy.d, healthy.cookie)).body;
    const noPlan = await setup(0, { accounts: brokenBilling(data) });
    expect(await accepted(noPlan.d, undefined, 2)).toBe(2);
    expect(await accepted(noPlan.d, `Bearer ${key}`, 6)).toBe(1);
    expect(await accepted(noPlan.d, `Bearer ${key}`, 6, { ip: "198.51.100.50" })).toBe(2);
    const noKeys = await setup(0, { accounts: brokenBilling(data, ["findApiKeyAccount"]) });
    expect(await score(noKeys.d, `Bearer ${key}`)).toMatchObject({ status: 503, body: { error: "unavailable" } });
  });

  // Fails if a call without a key reads account data, or another Authorization scheme changes what it answers today.
  it("a call without a key, or with another scheme, is anonymous and reads no account data", async () => {
    const spy = spiedAccounts(createMemoryAccountData());
    const { d } = await setup(0, { accounts: spy.accounts });
    expect((await score(d)).status).toBe(202);
    expect((await score(d, "Basic dXNlcjpwYXNz")).status).toBe(202);
    for (const other of ["Bearer sk_test_51abc", "Bearer eyJhbGciOi.J9.x", "Bearer ", "Bearer", "bearer abc rk_retrofit_x"]) expect((await score(d, other, { ip: "198.51.100.60", url: "https://same.example.com" })).status, other).toBe(202);
    expect(spy.calls).toEqual([]);
  });

  // P5-R3. Fails if one account can use the shared daily crawl cap with its key, repeats of one site count again, or the cap of one
  // account stops others.
  it("caps the sites of an account per day, whatever its hourly limit, and leaves the shared cap to others", async () => {
    const { d, cookie, clock } = await setup(0, { env: { ACCOUNT_SITES_PER_DAY_PRO: "8" } });
    await withBilling(d, OWNER);
    const { key } = (await create(d, cookie)).body;
    expect(await accepted(d, `Bearer ${key}`, 12)).toBe(8);
    const over = await score(d, `Bearer ${key}`);
    expect([over.status, over.body.error]).toEqual([429, "client_limit"]);
    expect(over.body.message).toContain("limit of 8 sites per day");
    expect(over.headers.get("retry-after")).toBeTruthy();
    expect(await accepted(d, undefined, 3)).toBe(3);
    clock.advance(24 * 3600_000);
    expect(await accepted(d, `Bearer ${key}`, 2, { url: "https://repeat.example.com" })).toBe(2);
    expect(await accepted(d, `Bearer ${key}`, 12)).toBe(7);
  });

  it("the cap of an account is at most half of the shared daily cap", async () => {
    const { d, cookie } = await setup(0, { env: { CRAWL_MAX_HOSTS_PER_DAY: "12" } });
    await withBilling(d, OWNER, { plan: "agency" });
    const { key } = (await create(d, cookie)).body;
    expect(await accepted(d, `Bearer ${key}`, 12)).toBe(6);
    expect(await accepted(d, undefined, 3, { ip: "198.51.100.70" })).toBe(3);
  });

  // Fails if the CORS contract changes (a key is for a server, never for a page).
  it("keeps the preflight as it was", () => {
    const res = handleScoreOptions();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toBe("GET");
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
  });

  // Fails if a key reaches a log line, a stored value or an answer, whatever the outcome.
  it("never logs, stores or answers a key", async () => {
    const { d, cookie } = await setup();
    await withBilling(d, OWNER);
    const { key } = (await create(d, cookie)).body;
    const bodies: string[] = [];
    for (const auth of [`Bearer ${key}`, `Bearer ${key}x`, `bearer ${key}`, `${key}`]) bodies.push(JSON.stringify((await score(d, auth)).body));
    const failing: TestDeps = { ...d, store: { ...d.store, putIfAbsent: async () => { throw new Error(`down ${key}`.slice(0, 4)); } } };
    bodies.push(JSON.stringify((await score(failing, `Bearer ${key}`)).body));
    for (const text of [lines.join("\n"), storeDump(d.backing), bodies.join("\n")]) expect(text).not.toContain((key as string).slice(12));
  });
});
