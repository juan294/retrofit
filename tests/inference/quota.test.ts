import { describe, expect, it } from "vitest";
import { type FreeConfig, loadFreeConfig } from "@/lib/config";
import { CountersUnavailable } from "@/lib/inference/errors";
import { capMessage, createQuota } from "@/lib/inference/quota";
import { createMemoryBacking, createMemoryStore } from "@/lib/store/memory";
import { fakeClock } from "../helpers/server-deps";

const free: FreeConfig = loadFreeConfig({}, false);
const START = Date.parse("2026-11-15T12:00:00Z");
const TEXT = /^Retrofit's free AI is used up for .+\. Use your own AI key to continue\.$/;

function setup() {
  const clock = fakeClock(START);
  const backing = createMemoryBacking();
  const store = createMemoryStore({ clock: clock.now, backing });
  return { clock, backing, quota: createQuota({ store, config: free, clock: clock.now }) };
}

function expectCap(r: { ok: boolean; message?: string }, reason: string) {
  expect(r).toMatchObject({ ok: false, status: 429, reason });
  const message = r.message ?? "";
  expect(message).toMatch(TEXT);
  expect(message).toBe(capMessage(reason as Parameters<typeof capMessage>[0]));
}

describe("quota caps", () => {
  // Fails if the public session call cap is off by one or its refusal lacks the cap text.
  it("refuses public session call N+1 with 429 and the cap text", async () => {
    const { quota } = setup();
    for (let i = 0; i < free.callsPerSession; i++) expect((await quota.admitCall({ sid: "s", pool: "public", network: "n" })).ok).toBe(true);
    expectCap(await quota.admitCall({ sid: "s", pool: "public", network: "n" }), "session_calls");
    // Another session is unaffected.
    expect((await quota.admitCall({ sid: "other", pool: "public", network: "n" })).ok).toBe(true);
  });

  // Fails if judge sessions use the public call cap, the cap is for the whole session and not for the UTC day (a judge
  // session lasts weeks), or the refusal sends a judge to a paid key or names no retry time.
  it("refuses judge call N+1 of a UTC day with 429 and the retry time", async () => {
    const { clock, quota } = setup();
    for (let i = 0; i < free.judgeCallsPerSessionDay; i++) expect((await quota.admitCall({ sid: "j", pool: "judge", network: "n" })).ok).toBe(true);
    const refused = await quota.admitCall({ sid: "j", pool: "judge", network: "n" });
    const retryAt = Date.parse("2026-11-16T00:00:00Z");
    expect(refused).toEqual({
      ok: false,
      status: 429,
      reason: "judge_session_calls",
      retryAt,
      message: "Judge access in this browser made its 200 AI calls for today. It works again at 00:00 UTC on 16 November 2026.",
    });
    expect((await quota.admitCall({ sid: "other", pool: "judge", network: "n" })).ok).toBe(true);
    expect(await quota.callsUsed({ sid: "j", pool: "judge" })).toBe(free.judgeCallsPerSessionDay + 1);
    clock.set(retryAt - 1);
    expect((await quota.admitCall({ sid: "j", pool: "judge", network: "n" })).ok).toBe(false);
    clock.set(retryAt);
    expect(await quota.callsUsed({ sid: "j", pool: "judge" })).toBe(0);
    expect((await quota.admitCall({ sid: "j", pool: "judge", network: "n" })).ok).toBe(true);
  });

  // Strix 2026-11-25, owner decision. Fails if many judge sessions of one network (the code is shared, and sessions last weeks) can make more
  // calls in a UTC day than the network's limit, if a call that its own session refuses uses the network's, if a call that the network refuses
  // uses its session's, if another network or the public pool is affected, or if the refusal asks a judge for a key.
  it("refuses judge calls past the network's limit of the UTC day, over all its sessions", async () => {
    const { clock, quota } = setup();
    const call = (sid: string, network = "n") => quota.admitCall({ sid, pool: "judge", network });
    const sessions = free.judgeCallsPerClientDay / free.judgeCallsPerSessionDay;
    expect(sessions).toBe(5);
    for (let s = 0; s < sessions; s++) {
      for (let i = 0; i < free.judgeCallsPerSessionDay; i++) expect((await call(`j${s}`)).ok).toBe(true);
      expect((await call(`j${s}`)) as object).toMatchObject({ ok: false, reason: "judge_session_calls" });
    }
    const retryAt = Date.parse("2026-11-16T00:00:00Z");
    expect(await call("fresh")).toEqual({
      ok: false,
      status: 429,
      reason: "judge_network_calls",
      retryAt,
      message: "Judges on this network made their 1000 AI calls for today. Judge access works again at 00:00 UTC on 16 November 2026.",
    });
    expect(await quota.callsUsed({ sid: "fresh", pool: "judge" })).toBe(0);
    expect((await call("fresh", "elsewhere")).ok).toBe(true);
    expect(await quota.callsUsed({ sid: "fresh", pool: "judge" })).toBe(1);
    expect([await quota.networkCapReached("n"), await quota.networkCapReached("elsewhere")]).toEqual([true, false]);
    expect((await quota.admitCall({ sid: "p", pool: "public", network: "n" })).ok).toBe(true);
    clock.set(retryAt);
    expect((await call("fresh")).ok).toBe(true);
  });

  // Fails if the public session's count starts again each day (the daily window is for the judge pool only).
  it("keeps the public count over days", async () => {
    const { clock, quota } = setup();
    for (let i = 0; i < free.callsPerSession; i++) await quota.admitCall({ sid: "s", pool: "public", network: "n" });
    clock.advance(3 * 86_400_000);
    expectCap(await quota.admitCall({ sid: "s", pool: "public", network: "n" }), "session_calls");
  });
});

describe("in-flight slots", () => {
  // Fails if more than inflightPerSession requests of one session run at once, or completion does not free a slot.
  it("caps per session and frees the slot on completion", async () => {
    const { quota } = setup();
    const a = await quota.acquireInflight("s");
    const b = await quota.acquireInflight("s");
    expect(a.ok && b.ok).toBe(true);
    expectCap(await quota.acquireInflight("s"), "inflight_session");
    if (a.ok) await a.release();
    expect((await quota.acquireInflight("s")).ok).toBe(true);
  });

  // Fails if a crashed request (never released) holds its slot beyond the 60 s lease.
  it("frees the slot after the lease when a request crashes", async () => {
    const { clock, quota } = setup();
    await quota.acquireInflight("s");
    await quota.acquireInflight("s");
    expectCap(await quota.acquireInflight("s"), "inflight_session");
    clock.advance(60_001);
    expect((await quota.acquireInflight("s")).ok).toBe(true);
  });

  // Fails if the global cap is not enforced across sessions, or a refused request keeps its session slot.
  it("caps globally and releases the session slot when the global cap refuses", async () => {
    const { quota } = setup();
    const held = [];
    for (let i = 0; i < free.inflightGlobal; i++) {
      const r = await quota.acquireInflight(`s${i}`);
      expect(r.ok).toBe(true);
      held.push(r);
    }
    expectCap(await quota.acquireInflight("late"), "inflight_global");
    for (const r of held.slice(0, 2)) if (r.ok) await r.release();
    expect((await quota.acquireInflight("late")).ok).toBe(true);
    expect((await quota.acquireInflight("late")).ok).toBe(true);
  });

  // Fails if slots are process-local (two server instances must share them).
  it("shares slots across store clients", async () => {
    const { clock, backing, quota } = setup();
    const other = createQuota({ store: createMemoryStore({ clock: clock.now, backing }), config: free, clock: clock.now });
    await quota.acquireInflight("s");
    await other.acquireInflight("s");
    expectCap(await quota.acquireInflight("s"), "inflight_session");
  });

  // Fails if releasing twice frees a slot that another request now holds.
  it("ignores a second release", async () => {
    const { quota } = setup();
    const a = await quota.acquireInflight("s");
    if (!a.ok) throw new Error("refused");
    await a.release();
    await quota.acquireInflight("s");
    await quota.acquireInflight("s");
    await a.release();
    expectCap(await quota.acquireInflight("s"), "inflight_session");
  });
});

describe("cap texts", () => {
  // Fails if any cap reason lacks the plan's visitor text or a distinct reason phrase.
  it("gives each reason the plan's text with its own phrase", () => {
    const reasons = ["session_calls", "inflight_session", "inflight_global", "public_pool", "judge_pool", "ledger"] as const;
    const texts = reasons.map((r) => capMessage(r));
    for (const t of texts) expect(t).toMatch(TEXT);
    expect(new Set(texts).size).toBe(reasons.length);
  });

  // Fails if a wait that ends by itself sends a judge to a paid key while the reserve has money.
  it("asks a judge for a key only when the money is used up", async () => {
    const { quota } = setup();
    await quota.acquireInflight("j", "judge");
    await quota.acquireInflight("j", "judge");
    const busy = await quota.acquireInflight("j", "judge");
    expect(busy).toMatchObject({ ok: false, reason: "inflight_session", message: "Judge access is busy with your other requests. Try again when they finish." });
    for (const reason of ["inflight_session", "inflight_global"] as const) expect(capMessage(reason, "judge")).not.toMatch(/key/i);
    for (const reason of ["judge_pool", "ledger"] as const) expect(capMessage(reason, "judge")).toMatch(TEXT);
  });
});

// Fails if a store failure surfaces as anything but CountersUnavailable.
it("throws CountersUnavailable when the store fails", async () => {
  const broken = new Proxy(createMemoryStore(), {
    get: () => async () => {
      throw new Error("connection refused");
    },
  });
  const quota = createQuota({ store: broken, config: free, clock: () => START });
  await expect(quota.admitCall({ sid: "s", pool: "public", network: "n" })).rejects.toBeInstanceOf(CountersUnavailable);
  await expect(quota.acquireInflight("s")).rejects.toBeInstanceOf(CountersUnavailable);
});
