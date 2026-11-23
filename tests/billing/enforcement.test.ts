import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryAccountData } from "@/lib/accounts/memory";
import { handlePublish, handleUnpublish } from "@/lib/api/publish";
import { handleSaveReport } from "@/lib/api/saved-reports";
import { handleAnalyze } from "@/lib/api/analyze";
import { handleScore } from "@/lib/api/score";
import { handleJudgeUpgrade, handleSession, sessionTexts } from "@/lib/inference/session";
import { PLAN_TEXT } from "@/lib/site/billing-texts";
import { PUBLISH_TEXT } from "@/lib/site/publish-texts";
import { accountCookie, analyzeRequest, cookieFrom, holdAllSlots, postRequest, scoreRequest, type TestDeps, type TestDepsOptions } from "../helpers/server-deps";
import { HOST, listedAnalysis, snapshotOf, verifiedClaim } from "../publish/setup";
import { billingDeps, brokenBilling, OWNER, spiedAccounts, withBilling } from "./setup";

afterEach(() => vi.restoreAllMocks());

const JUDGE = "judge-code-unit-0123456789";
const DAY_MS = 24 * 3600_000;

/** A verified owner of HOST with a ready analysis, `offsetMs` after the start. */
async function owner(offsetMs: number, o: TestDepsOptions = {}) {
  const r = billingDeps(offsetMs, o);
  const { d } = r;
  await verifiedClaim(d);
  const analysis = await listedAnalysis(d, { snapshot: snapshotOf(HOST, new Date(d.clock()).toISOString()) });
  const cookie = await accountCookie(d);
  const publish = () => handlePublish(postRequest("/api/publish", { host: HOST }, { cookie }), d);
  const save = () => handleSaveReport(postRequest("/api/account/reports", { analysisId: analysis.id }, { cookie }), d);
  return { ...r, cookie, publish, save };
}
const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("publishing and saving", () => {
  // Fails if a signed-in account needs a plan 1 ms before the start (success criterion 7).
  it("need no plan before the start", async () => {
    const o = await owner(-1);
    expect((await o.publish()).status).toBe(200);
    expect((await o.save()).status).toBe(200);
  });

  // Fails if a Free account publishes or saves from the start on, the answer hides the way out, or a refusal leaves anything public or counted.
  it("need a paid plan from the start on", async () => {
    const o = await owner(0);
    for (let i = 0; i < 70; i++) {
      const res = await o.publish();
      expect(res.status).toBe(403);
      if (i === 0) expect(await bodyOf(res)).toEqual({ error: "plan_required", message: PLAN_TEXT.required.publish, href: "/pricing" });
    }
    const saved = await o.save();
    expect(saved.status).toBe(403);
    expect(await bodyOf(saved)).toEqual({ error: "plan_required", message: PLAN_TEXT.required.saved_reports, href: "/pricing" });
    expect(await o.d.accounts.getPublicSite(HOST)).toBeNull();
    expect(await o.d.accounts.listSavedReports(OWNER)).toEqual([]);
    await withBilling(o.d, OWNER);
    expect((await o.publish()).status).toBe(200);
    expect((await o.save()).status).toBe(200);
  });

  // Fails if a Free account learns of the plan before its claim problem, or another account's claim is confirmed by the refusal.
  it("name the claim problem first", async () => {
    const { d } = billingDeps(0);
    const res = await handlePublish(postRequest("/api/publish", { host: HOST }, { cookie: await accountCookie(d) }), d);
    expect(await bodyOf(res)).toMatchObject({ error: "not_yours", message: PUBLISH_TEXT.noClaim(HOST) });
  });

  // Fails if the end of a plan takes a page down, or lets it refresh, or stops its owner from unpublishing (the least destructive rule).
  it("when the plan ends, the published page stays public; a refresh and a save need a plan; unpublish still works", async () => {
    const o = await owner(0);
    const customer = await withBilling(o.d, OWNER);
    expect((await o.publish()).status).toBe(200);
    o.clock.advance(2 * DAY_MS);
    await o.d.accounts.applyBillingState(customer, { plan: "pro", status: "canceled", currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionId: "sub_unit", observedAt: new Date(o.d.clock()).toISOString() });
    await listedAnalysis(o.d, { snapshot: snapshotOf(HOST, new Date(o.d.clock()).toISOString()) });
    const refresh = await o.publish();
    expect([refresh.status, (await bodyOf(refresh)).error]).toEqual([403, "plan_required"]);
    expect((await o.save()).status).toBe(403);
    const site = await o.d.accounts.getPublicSite(HOST);
    expect(site?.host).toBe(HOST);
    expect((await handleUnpublish(postRequest("/api/publish/remove", { host: HOST }, { cookie: o.cookie }), o.d)).status).toBe(200);
  });

  // Fails if a billing outage publishes or saves for free, or answers anything but a retry.
  it("answer a retry when the plan cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const o = await owner(0, { accounts: brokenBilling(createMemoryAccountData()) });
    for (const run of [o.publish, o.save]) {
      const res = await run();
      expect(res.status).toBe(503);
      expect(await bodyOf(res)).toEqual({ error: "billing_unavailable", message: PLAN_TEXT.unavailable });
    }
    expect(await o.d.accounts.getPublicSite(HOST)).toBeNull();
  });
});

describe("the free AI session", () => {
  const start = (d: TestDeps, cookie = "") => handleSession(postRequest("/api/inference/session", undefined, { cookie }), d);

  // Fails if a Free account's session starts after the start, a paid one's is refused, or a visitor without an account changes.
  it("needs a paid plan for a signed-in account from the start on; visitors are as before", async () => {
    const { d } = billingDeps(0);
    const cookie = await accountCookie(d);
    const refused = await start(d, cookie);
    expect(refused.status).toBe(403);
    expect(await bodyOf(refused)).toEqual({ error: "plan_required", message: PLAN_TEXT.required.free_ai_preview, href: "/pricing" });
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect((await start(d)).status).toBe(200);
    await withBilling(d, OWNER);
    expect((await start(d, cookie)).status).toBe(200);
  });

  // Fails if a Free account meets a refusal before the start, or a renewal keeps a session past it.
  it("is open to every account before the start, and a Free account's renewal ends with it", async () => {
    const { d, clock } = billingDeps(-1);
    const cookie = await accountCookie(d);
    const first = await start(d, cookie);
    expect(first.status).toBe(200);
    clock.advance(1);
    expect((await start(d, `${cookie}; ${cookieFrom(first)}`)).status).toBe(403);
  });

  // Fails if a judge's session is refused because the judge is signed in to an account.
  it("a judge session stays exempt", async () => {
    const { d, clock } = billingDeps(-1, { env: { JUDGE_CODE: JUDGE } });
    const account = await accountCookie(d);
    const first = await start(d, account);
    const up = await handleJudgeUpgrade(postRequest("/api/inference/session/judge", { code: JUDGE }, { cookie: cookieFrom(first) }), d);
    expect(await bodyOf(up)).toMatchObject({ pool: "judge" });
    clock.advance(1);
    const renewed = await start(d, `${account}; ${cookieFrom(up)}`);
    expect([renewed.status, (await bodyOf(renewed)).pool]).toEqual([200, "judge"]);
  });

  // Fails if an outage starts a free session for an account whose plan is unknown, or hides the own-key way out.
  it("answers the own-key text when the plan cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { d } = billingDeps(0, { accounts: brokenBilling(createMemoryAccountData()) });
    const res = await start(d, await accountCookie(d));
    expect(res.status).toBe(503);
    expect(await bodyOf(res)).toEqual({ error: "unavailable", message: sessionTexts.unavailable });
  });
});

describe("the open paths before the start", () => {
  // Fails if the score API, the free AI session or the judge upgrade makes one more Store, account data or Stripe call
  // 1 ms before the start than long before it (judges first).
  it("score, session and judge make exactly the calls they made before billing existed", async () => {
    const run = async (offsetMs: number) => {
      const ops: string[] = [];
      const spy = spiedAccounts(createMemoryAccountData());
      const { d } = billingDeps(offsetMs, { accounts: spy.accounts, env: { JUDGE_CODE: JUDGE, SCORE_WAIT_MS: "1" }, instrument: (op, key) => void ops.push(`${op} ${key.split(":")[0]}`) });
      await holdAllSlots(d);
      const account = await accountCookie(d);
      const answers: number[] = [];
      ops.length = 0;
      const session = await handleSession(postRequest("/api/inference/session", undefined), d);
      answers.push(session.status);
      answers.push((await handleSession(postRequest("/api/inference/session", undefined, { cookie: account }), d)).status);
      answers.push((await handleJudgeUpgrade(postRequest("/api/inference/session/judge", { code: JUDGE }, { cookie: cookieFrom(session) }), d)).status);
      answers.push((await handleAnalyze(analyzeRequest({ url: "https://spy2.example.com" }), d)).status);
      // Last: its wait moves the clock past the start.
      answers.push((await handleScore(scoreRequest("?url=https%3A%2F%2Fspy.example.com"), d)).status);
      await d.settle();
      return { answers, ops: ops.sort(), accounts: spy.calls, stripe: [...d.fixtureBilling.calls] };
    };
    const before = await run(-1);
    expect(before.answers).toEqual([200, 200, 200, 200, 202]);
    expect(before).toEqual(await run(-57 * DAY_MS));
    expect([before.accounts, before.stripe]).toEqual([[], []]);
    expect(before.ops.join()).not.toMatch(/billing|free-analyses|account-session|api-key/);
  });
});
