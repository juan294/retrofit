import { describe, expect, it } from "vitest";
import { createStartController, type StartState } from "@/components/analysis/start-controller";
import type { AnalysisRequestResult, RequestOptions } from "@/components/analysis/request";

/** Manual timers and a request whose answers the test releases one at a time. */
function harness() {
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const requests: { url: string; options: RequestOptions; answer: (r: AnalysisRequestResult) => void }[] = [];
  const states: StartState[] = [];
  const results: AnalysisRequestResult[] = [];
  const controller = createStartController({
    request: (url, options) => new Promise((resolve) => void requests.push({ url, options, answer: resolve })),
    setTimer: (fn) => {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => void timers.delete(id as number),
    onState: (s) => void states.push(s),
    onResult: (r) => void results.push(r),
  });
  const fireTimers = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const fn of due) fn();
  };
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return { controller, timers, requests, states, results, fireTimers, settle };
}

const OK: AnalysisRequestResult = { ok: true, id: "c".repeat(32) };
const URL_ = "https://pending.example.com";

describe("createStartController (review F3, F4)", () => {
  // F3. Fails if the automatic retry and a click both send a request, or if the waiting state does not
  // mark the page busy (the Retry button would stay enabled while the automatic retry waits).
  it("sends one request when a click comes while the automatic retry waits", async () => {
    const h = harness();
    h.controller.schedule(URL_, 2000, "waiting text", 2);
    expect(h.states.at(-1)).toEqual({ busy: true, waiting: "waiting text" });
    h.controller.start(URL_);
    h.fireTimers();
    expect(h.requests).toHaveLength(1);
    expect(h.timers.size).toBe(0);
  });

  // F3. Fails if a second click (or a timer) starts another request while one is in flight.
  it("ignores starts and schedules while a request is in flight", async () => {
    const h = harness();
    h.controller.start(URL_, 2);
    h.controller.start(URL_);
    h.controller.schedule(URL_, 2000, "waiting text");
    h.fireTimers();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.options.attempts).toBe(2);
    h.requests[0]?.answer({ ok: false, failure: { code: "counting", message: "m" } });
    await h.settle();
    expect(h.results).toEqual([{ ok: false, failure: { code: "counting", message: "m" } }]);
    expect(h.states.at(-1)).toEqual({ busy: false, waiting: null });
    h.controller.start(URL_);
    expect(h.requests).toHaveLength(2);
  });

  // F4. Fails if leaving the page does not abort the request, or if a late success is still delivered
  // (the page would navigate after the visitor left).
  it("aborts on dispose and drops a late success", async () => {
    const h = harness();
    h.controller.start(URL_);
    h.controller.dispose();
    expect(h.requests[0]?.options.signal?.aborted).toBe(true);
    h.requests[0]?.answer(OK);
    await h.settle();
    expect(h.results).toEqual([]);
  });

  // F4. Fails if a scheduled automatic retry still fires after the page is gone.
  it("cancels a scheduled start on dispose", () => {
    const h = harness();
    h.controller.schedule(URL_, 2000, "waiting text");
    h.controller.dispose();
    h.fireTimers();
    expect(h.requests).toHaveLength(0);
  });

  // Fails if the retry text from requestAnalysis is not shown while it waits, or a success re-enables the
  // form before the page navigates.
  it("shows the retry text while waiting and stays busy after a success", async () => {
    const h = harness();
    h.controller.start(URL_);
    h.requests[0]?.options.onRetry?.("retrying");
    expect(h.states.at(-1)).toEqual({ busy: true, waiting: "retrying" });
    h.requests[0]?.answer(OK);
    await h.settle();
    expect(h.results).toEqual([OK]);
    expect(h.states.at(-1)).toEqual({ busy: true, waiting: null });
  });
});
