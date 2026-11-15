import { describe, expect, it } from "vitest";
import { COUNTING_ATTEMPTS, requestAnalysis } from "@/components/analysis/request";
import { visitorTexts } from "@/lib/analysis/texts";

const COUNTING = { error: "counting", message: visitorTexts.counting, retryAfterSeconds: 2 };

/** A fetch that answers each POST /api/analyze with the next scripted response and records the calls. */
function scripted(answers: { status: number; body: unknown }[]) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    const next = answers.shift();
    if (!next) throw new Error("no scripted answer left");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("requestAnalysis (validation V04)", () => {
  // Fails if a 503 counting answer becomes a failure screen at once, if the retry ignores the server's
  // retryAfterSeconds, or if the visitor is not told that Retrofit is trying again.
  it("tries again after retryAfterSeconds on 503 counting and returns the new analysis id", async () => {
    const { fetch, calls } = scripted([
      { status: 503, body: COUNTING },
      { status: 200, body: { id: "a".repeat(32) } },
    ]);
    const sleeps: number[] = [];
    const shown: string[] = [];
    const r = await requestAnalysis("https://pending.example.com", { fetch, sleep: async (ms) => void sleeps.push(ms), onRetry: (m) => void shown.push(m) });
    expect(r).toEqual({ ok: true, id: "a".repeat(32) });
    expect(sleeps).toEqual([2000]);
    expect(shown).toEqual([visitorTexts.countingRetry]);
    expect(calls).toEqual([
      { url: "/api/analyze", body: { url: "https://pending.example.com" } },
      { url: "/api/analyze", body: { url: "https://pending.example.com" } },
    ]);
  });

  // Fails if the automatic retry never ends (each attempt counts against the visitor's hourly limit), or if
  // the final answer is not the server's truthful counting text.
  it(`stops after ${COUNTING_ATTEMPTS} attempts and returns the counting failure`, async () => {
    const { fetch, calls } = scripted(Array.from({ length: COUNTING_ATTEMPTS }, () => ({ status: 503, body: COUNTING })));
    const r = await requestAnalysis("https://pending.example.com", { fetch, sleep: async () => {} });
    expect(r).toEqual({ ok: false, failure: { code: "counting", message: visitorTexts.counting } });
    expect(calls).toHaveLength(COUNTING_ATTEMPTS);
  });

  // Fails if the page's own attempt limit is ignored (a page that already made one attempt asks for fewer).
  it("honors a smaller attempt limit", async () => {
    const { fetch, calls } = scripted([
      { status: 503, body: COUNTING },
      { status: 503, body: COUNTING },
    ]);
    const r = await requestAnalysis("https://pending.example.com", { fetch, sleep: async () => {}, attempts: 2 });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(2);
  });

  // Fails if another failure (a limit, a bad address) is retried automatically, or loses its retryAt.
  it("returns any other failure at once, with its retryAt", async () => {
    const daily = { error: "daily_limit", message: visitorTexts.dailyLimit, retryAt: "2026-11-16T00:00:00.000Z" };
    const { fetch, calls } = scripted([{ status: 429, body: daily }]);
    const r = await requestAnalysis("https://full.example.com", { fetch, sleep: async () => {} });
    expect(r).toEqual({ ok: false, failure: { code: "daily_limit", message: visitorTexts.dailyLimit, retryAt: "2026-11-16T00:00:00.000Z" } });
    expect(calls).toHaveLength(1);
  });

  // Fails if a network error or a body without text throws instead of giving the general visitor text.
  it("returns the unavailable text when the request fails or the body is unreadable", async () => {
    const down = (async () => {
      throw new TypeError("network down");
    }) as typeof globalThis.fetch;
    expect(await requestAnalysis("https://a.example.com", { fetch: down })).toEqual({ ok: false, failure: { code: "unavailable", message: visitorTexts.unavailable } });
    const garbled = (async () => new Response("not json", { status: 502 })) as typeof globalThis.fetch;
    expect(await requestAnalysis("https://a.example.com", { fetch: garbled })).toEqual({ ok: false, failure: { code: "unavailable", message: visitorTexts.unavailable } });
  });

  // Review F4. Fails if an aborted start keeps retrying, or resolves with an id the page would navigate to.
  it("stops when its signal aborts during the retry wait, without a second request", async () => {
    const { fetch, calls } = scripted([
      { status: 503, body: COUNTING },
      { status: 200, body: { id: "b".repeat(32) } },
    ]);
    const controller = new AbortController();
    const r = await requestAnalysis("https://pending.example.com", { fetch, signal: controller.signal, sleep: async () => controller.abort() });
    expect(r).toEqual({ ok: false, failure: { code: "aborted", message: visitorTexts.unavailable } });
    expect(calls).toHaveLength(1);
  });

  // Review F4. Fails if the signal does not reach fetch, so leaving the page cannot cancel the request.
  it("passes its signal to fetch and reports an abort as aborted", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetch = (async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }) as typeof globalThis.fetch;
    const r = await requestAnalysis("https://a.example.com", { fetch, signal: controller.signal });
    expect(seen).toBe(controller.signal);
    expect(r).toEqual({ ok: false, failure: { code: "aborted", message: visitorTexts.unavailable } });
  });
});
