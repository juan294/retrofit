import { describe, expect, it } from "vitest";
import { type FreeConfig, loadFreeConfig } from "@/lib/config";
import { CountersUnavailable } from "@/lib/inference/errors";
import { capMessage, createQuota } from "@/lib/inference/quota";
import { createMemoryBacking, createMemoryStore } from "@/lib/store/memory";
import { fakeClock } from "../helpers/server-deps";

const free: FreeConfig = loadFreeConfig({}, false);
const START = Date.parse("2026-11-15T12:00:00Z");
const TEXT = /^Retrofit's free AI is used up for .+\. Paste your own key in AI settings to continue\.$/;

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
    for (let i = 0; i < free.callsPerSession; i++) expect((await quota.admitCall({ sid: "s", pool: "public" })).ok).toBe(true);
    expectCap(await quota.admitCall({ sid: "s", pool: "public" }), "session_calls");
    // Another session is unaffected.
    expect((await quota.admitCall({ sid: "other", pool: "public" })).ok).toBe(true);
  });

  // Fails if judge sessions use the public call cap.
  it("refuses judge session call N+1 with 429 and the cap text", async () => {
    const { quota } = setup();
    for (let i = 0; i < free.judgeCallsPerSession; i++) expect((await quota.admitCall({ sid: "j", pool: "judge" })).ok).toBe(true);
    expectCap(await quota.admitCall({ sid: "j", pool: "judge" }), "judge_session_calls");
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
    const reasons = ["session_calls", "judge_session_calls", "client_sessions", "judge_client_sessions", "inflight_session", "inflight_global", "public_pool", "judge_pool", "ledger"] as const;
    const texts = reasons.map((r) => capMessage(r));
    for (const t of texts) expect(t).toMatch(TEXT);
    expect(new Set(texts).size).toBe(reasons.length);
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
  await expect(quota.admitCall({ sid: "s", pool: "public" })).rejects.toBeInstanceOf(CountersUnavailable);
  await expect(quota.acquireInflight("s")).rejects.toBeInstanceOf(CountersUnavailable);
});
