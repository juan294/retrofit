import { describe, expect, it } from "vitest";
import { BLOCKED_TEXT, RETIRED_TEXT, createFetchGuard, installFetchGuard } from "@/lib/preview/fetch-guard";

// The boundary: the browser's original fetch is replaced by a recorder. The recorder builds the
// Request the platform would build from (input, init), so assertions read the effective
// method, redirect mode, headers and body, as the network layer would see them.
type Call = { input: RequestInfo | URL; init: RequestInit | undefined };

const PAGE = "http://127.0.0.1:3010";
const ROUTER_A = "https://api.example/api/v1";
const ROUTER_B = "https://router-b.example/v1";
const PEER_A = "http://peer-a.fixture.test:3011";
const PEER_B = "http://peer-b.fixture.test:3011";
const THIRD = "http://third.fixture.test:3013";

function setup() {
  const calls: Call[] = [];
  const originalFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response("ok");
  };
  const logs: string[] = [];
  const guard = createFetchGuard({ pageOrigin: PAGE, originalFetch, log: (m) => logs.push(m) });
  return { guard, calls, logs, originalFetch };
}

function effective(call: Call | undefined): Request {
  if (!call) throw new Error("the recorder saw no call");
  return new Request(call.input, call.init);
}

async function expectBlocked(promise: Promise<Response>, origin: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TypeError);
  expect((error as TypeError).message).toBe(BLOCKED_TEXT(origin));
}

describe("BLOCKED_TEXT", () => {
  // Fails if the visitor-facing text changes from the parent plan's stuck-state row.
  it("names the origin in the plan's text", () => {
    expect(BLOCKED_TEXT("http://third.fixture.test:3013")).toBe(
      "Retrofit blocked a request to http://third.fixture.test:3013 that was not approved.",
    );
  });
});

describe("rule 1: same origin, not an agent artifact", () => {
  // Fails if the guard copies or rewrites init for ordinary same-origin requests.
  it("passes input and init unchanged by identity", async () => {
    const { guard, calls } = setup();
    const init: RequestInit = { method: "GET", credentials: "same-origin" };
    const input = `${PAGE}/api/score?url=https%3A%2F%2Fbakery.example`;
    await guard.fetch(input, init);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe(input);
    expect(calls[0]!.init).toBe(init);
  });

  // Fails if relative URLs are not resolved against the page origin (they would be refused).
  it("passes a relative path and a URL object unchanged", async () => {
    const { guard, calls } = setup();
    const url = new URL(`${PAGE}/api/analyze`);
    await guard.fetch("/api/inference/session", undefined);
    await guard.fetch(url);
    expect(calls.map((c) => c.input)).toEqual(["/api/inference/session", url]);
    expect(calls[0]!.init).toBeUndefined();
  });

  // Fails if rule 3 is applied before rule 1 to a same-origin router (deviation row: the free path is first-party).
  it("leaves a same-origin router (the free path) unchanged", async () => {
    const { guard, calls } = setup();
    guard.setRouter(`${PAGE}/api/inference/v1`);
    const init: RequestInit = { method: "POST", body: "{}" };
    await guard.fetch(`${PAGE}/api/inference/v1/chat/completions`, init);
    await guard.fetch(`${PAGE}/api/inference/v1/models`);
    expect(calls[0]!.init).toBe(init);
    expect(calls[1]!.init).toBeUndefined();
  });
});

describe("rule 2: same-origin agent artifacts", () => {
  const artifacts = [
    "/p/abc123/agent-manifest.json",
    "/p/abc123/site_bakery_example.network.json",
    "/p/abc123/site-content.json",
    "/p/abc123/content-actions.js",
    "/p/abc123/links.json",
    "/agent-manifest.json",
    "/retrofit_guide.network.json",
    "/links.json",
  ];

  // Fails if any artifact path loses redirect "manual" or if the guard drops the caller's other init fields.
  it.each(artifacts)("%s gets redirect error and keeps the other options", async (path) => {
    const { guard, calls } = setup();
    await guard.fetch(`${PAGE}${path}`, { cache: "no-store", headers: { "x-test": "1" } });
    const request = effective(calls[0]);
    expect(request.redirect).toBe("manual");
    expect(request.cache).toBe("no-store");
    expect(request.headers.get("x-test")).toBe("1");
  });

  // Fails if the artifact check is a substring test (for example "/api/p/" or "links.json" anywhere).
  it("does not treat lookalike paths as artifacts", async () => {
    const { guard, calls } = setup();
    const init: RequestInit = { method: "GET" };
    await guard.fetch(`${PAGE}/api/links.json.txt`, init);
    await guard.fetch(`${PAGE}/pricing/agent-manifest.json.bak`, init);
    expect(calls.map((c) => c.init)).toEqual([init, init]);
  });
});

describe("rule 3: the cross-origin router", () => {
  // Fails if any of the three runtime requests is refused or sent without redirect "manual".
  it("allows chat, models and the probe with redirect error", async () => {
    const { guard, calls } = setup();
    guard.setRouter(ROUTER_A);
    await guard.fetch(`${ROUTER_A}/chat/completions`, { method: "POST", body: "{}" });
    await guard.fetch(`${ROUTER_A}/models`, { cache: "no-store" });
    await guard.fetch("https://api.example/agent-manifest.json", { cache: "no-store" });
    expect(calls.map((c) => effective(c).url)).toEqual([
      `${ROUTER_A}/chat/completions`,
      `${ROUTER_A}/models`,
      "https://api.example/agent-manifest.json",
    ]);
    expect(calls.map((c) => effective(c).redirect)).toEqual(["manual", "manual", "manual"]);
  });

  // Fails if router matching is by origin only, by path prefix, ignores the method or ignores the query.
  it.each([
    ["GET", `${ROUTER_A}/chat/completions`],
    ["POST", `${ROUTER_A}/models`],
    ["POST", "https://api.example/agent-manifest.json"],
    ["GET", "https://api.example/api/agent-manifest.json"],
    ["GET", "https://api.example/peer_demo.hocon"],
    ["POST", "https://api.example/chat/completions"],
    ["POST", `${ROUTER_A}/chat/completions/extra`],
    ["GET", `${ROUTER_A}/models?all=1`],
    ["GET", "https://api.example/api/v1x/models"],
  ])("refuses %s %s before the recorder sees it", async (method, url) => {
    const { guard, calls } = setup();
    guard.setRouter(ROUTER_A);
    await expectBlocked(guard.fetch(url, { method }), "https://api.example");
    expect(calls).toHaveLength(0);
  });

  // Fails if setRouter adds to the previous router instead of replacing it.
  it("replaces the previous router entirely", async () => {
    const { guard, calls } = setup();
    guard.setRouter(ROUTER_A);
    guard.setRouter(ROUTER_B);
    await expectBlocked(guard.fetch(`${ROUTER_A}/chat/completions`, { method: "POST" }), "https://api.example");
    await guard.fetch(`${ROUTER_B}/chat/completions`, { method: "POST" });
    expect(calls).toHaveLength(1);
    guard.setRouter(null);
    await expectBlocked(guard.fetch(`${ROUTER_B}/models`), "https://router-b.example");
    expect(guard.state().router).toBeNull();
  });

  // Fails if the router check ignores a trailing slash the runtime strips (llm.js:55).
  it("accepts a router base URL with a trailing slash", async () => {
    const { guard, calls } = setup();
    guard.setRouter(`${ROUTER_A}/`);
    await guard.fetch(`${ROUTER_A}/chat/completions`, { method: "POST" });
    expect(calls).toHaveLength(1);
  });
});

describe("rule 4: provisional provider", () => {
  // Fails if authorizeProvider grants chat or the probe, or if /models is sent without redirect "manual".
  it("allows only GET /models while validation runs", async () => {
    const { guard, calls } = setup();
    guard.setRouter(ROUTER_A);
    guard.authorizeProvider(ROUTER_B);
    await guard.fetch(`${ROUTER_B}/models`, { cache: "no-store" });
    expect(effective(calls[0]).redirect).toBe("manual");
    await expectBlocked(guard.fetch(`${ROUTER_B}/chat/completions`, { method: "POST" }), "https://router-b.example");
    await expectBlocked(guard.fetch("https://router-b.example/agent-manifest.json"), "https://router-b.example");
    expect(calls).toHaveLength(1);
  });

  // Fails if revokeProvider leaves provisional access in place (failed validation or "Forget my key").
  it("revoking the provider removes access and keeps the active router", async () => {
    const { guard, calls } = setup();
    guard.setRouter(ROUTER_A);
    guard.authorizeProvider(ROUTER_B);
    guard.revokeProvider();
    await expectBlocked(guard.fetch(`${ROUTER_B}/models`), "https://router-b.example");
    await guard.fetch(`${ROUTER_A}/models`);
    expect(calls).toHaveLength(1);
    expect(guard.state().provisionalProvider).toBeNull();
  });

  // Fails if the switch sequence (setRouter(new) then revokeProvider) leaves the old router with access.
  it("after a successful switch the new router has full access and the old one none", async () => {
    const { guard, calls } = setup();
    guard.setRouter(ROUTER_A);
    guard.authorizeProvider(ROUTER_B);
    guard.setRouter(ROUTER_B);
    guard.revokeProvider();
    await guard.fetch(`${ROUTER_B}/chat/completions`, { method: "POST" });
    await expectBlocked(guard.fetch(`${ROUTER_A}/chat/completions`, { method: "POST" }), "https://api.example");
    expect(calls).toHaveLength(1);
  });
});

describe("rule 5: policy peers need policy and approval", () => {
  // Fails if a peer in allowed_peers is reachable before the visitor approves it.
  it("refuses a policy peer without approval", async () => {
    const { guard, calls } = setup();
    guard.setPolicyPeers([PEER_A, PEER_B]);
    await expectBlocked(guard.fetch(`${PEER_A}/agent-manifest.json`), PEER_A);
    expect(calls).toHaveLength(0);
  });

  // Fails if the wrapper approves on "decline", changes the decision, or skips the original.
  it("a declined consent approves nothing and returns the decision unchanged", async () => {
    const { guard, calls } = setup();
    guard.setPolicyPeers([PEER_A]);
    const seen: unknown[] = [];
    const wrapped = guard.wrapRequestConsent(async (info) => {
      seen.push(info);
      return "decline";
    });
    const info = { kind: "network", peerLabel: "Peer", peerOrigin: "peer-a.fixture.test:3011", requestText: "hi", est: 1 };
    await expect(wrapped(info)).resolves.toBe("decline");
    expect(seen).toEqual([info]);
    await expectBlocked(guard.fetch(`${PEER_A}/agent-manifest.json`), PEER_A);
    expect(calls).toHaveLength(0);
  });

  // Fails if "allow" does not approve the mapped origin, or if approved peer requests may follow redirects.
  it("an allowed consent approves the peer and its requests get redirect error", async () => {
    const { guard, calls } = setup();
    guard.setPolicyPeers([PEER_A, PEER_B]);
    const wrapped = guard.wrapRequestConsent(async () => "allow");
    await expect(wrapped({ kind: "network", peerOrigin: "peer-a.fixture.test:3011" })).resolves.toBe("allow");
    await guard.fetch(`${PEER_A}/agent-manifest.json`);
    await guard.fetch(`${PEER_A}/peer_demo.network.json`, { headers: { accept: "application/json" } });
    expect(calls.map((c) => effective(c).redirect)).toEqual(["manual", "manual"]);
    expect(effective(calls[1]).headers.get("accept")).toBe("application/json");
    await expectBlocked(guard.fetch(`${PEER_B}/agent-manifest.json`), PEER_B);
    expect(calls).toHaveLength(2);
  });

  // Fails if the wrapper calls the original without the engine as `this` (runtime/engine.js:130 uses this).
  it("the wrapper keeps the engine as this", async () => {
    const { guard } = setup();
    const engine = {
      label: "engine",
      requestConsent(this: { label: string }, _info: { peerOrigin?: unknown }): Promise<unknown> {
        return Promise.resolve(this.label === "engine" ? "allow" : "decline");
      },
    };
    engine.requestConsent = guard.wrapRequestConsent(engine.requestConsent);
    await expect(engine.requestConsent({ peerOrigin: "peer-a.fixture.test:3011" })).resolves.toBe("allow");
  });

  // Fails if consent alone opens an origin that is not in allowed_peers.
  it("an allowed consent for an origin outside the policy approves nothing", async () => {
    const { guard, calls } = setup();
    guard.setPolicyPeers([PEER_A]);
    const wrapped = guard.wrapRequestConsent(async () => "allow");
    await wrapped({ kind: "network", peerOrigin: "third.fixture.test:3013" });
    await expectBlocked(guard.fetch(`${THIRD}/agent-manifest.json`), THIRD);
    expect(calls).toHaveLength(0);
  });

  // Fails if setPolicyPeers keeps approvals for origins it removed, or restores them when re-added.
  it("setPolicyPeers resets approvals that are no longer in policy", async () => {
    const { guard, calls } = setup();
    guard.setPolicyPeers([PEER_A, PEER_B]);
    guard.approveFromConsent("peer-a.fixture.test:3011");
    guard.approveFromConsent("peer-b.fixture.test:3011");
    guard.setPolicyPeers([PEER_B]);
    expect(guard.state().approvedPeers).toEqual([PEER_B]);
    guard.setPolicyPeers([PEER_A, PEER_B]);
    await expectBlocked(guard.fetch(`${PEER_A}/agent-manifest.json`), PEER_A);
    await guard.fetch(`${PEER_B}/agent-manifest.json`);
    expect(calls).toHaveLength(1);
  });

  // Fails if clearApprovals leaves any approval in place (reboot of the preview).
  it("clearApprovals removes every approval", async () => {
    const { guard, calls } = setup();
    guard.setPolicyPeers([PEER_A]);
    guard.approveFromConsent("peer-a.fixture.test:3011");
    guard.clearApprovals();
    await expectBlocked(guard.fetch(`${PEER_A}/agent-manifest.json`), PEER_A);
    expect(calls).toHaveLength(0);
    expect(guard.state().policyPeers).toEqual([PEER_A]);
  });

  // Fails if a peer approval opens the router origin beyond its three requests (redirects spec: hocon on the router origin).
  it("an approved peer on the router origin is still limited to the router requests", async () => {
    const { guard, calls } = setup();
    guard.setRouter(ROUTER_A);
    guard.setPolicyPeers(["https://api.example"]);
    guard.approveFromConsent("api.example");
    await expectBlocked(guard.fetch("https://api.example/peer_demo.hocon"), "https://api.example");
    expect(calls).toHaveLength(0);
  });
});

describe("refusals of other origins", () => {
  // Fails if an origin that is never configured reaches the network.
  it("refuses a third origin before the recorder sees it", async () => {
    const { guard, calls } = setup();
    guard.setRouter(ROUTER_A);
    guard.setPolicyPeers([PEER_A]);
    guard.approveFromConsent("peer-a.fixture.test:3011");
    await expectBlocked(guard.fetch(`${THIRD}/agent-manifest.json`), THIRD);
    await expectBlocked(guard.fetch(new URL(`${THIRD}/x`)), THIRD);
    expect(calls).toHaveLength(0);
  });

  // Fails if the guard throws synchronously (callers using fetch(...).catch would crash) instead of rejecting.
  it("rejects instead of throwing synchronously", () => {
    const { guard } = setup();
    let promise: Promise<Response> | undefined;
    expect(() => {
      promise = guard.fetch(`${THIRD}/x`);
    }).not.toThrow();
    return expect(promise).rejects.toBeInstanceOf(TypeError);
  });
});

describe("Request objects", () => {
  // Fails if the guard reads the method only from init (a POST Request would be refused) or drops the body or headers.
  it("keeps the Request's method, body and headers and sets redirect error", async () => {
    const { guard, calls } = setup();
    guard.setRouter(ROUTER_A);
    const request = new Request(`${ROUTER_A}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });
    await guard.fetch(request);
    const sent = effective(calls[0]);
    expect(sent.method).toBe("POST");
    expect(sent.redirect).toBe("manual");
    expect(sent.headers.get("authorization")).toBe("Bearer test-key");
    expect(await sent.text()).toBe('{"model":"m"}');
  });

  // Fails if the guard ignores the Request's method (default GET) and allows a GET Request to the chat path.
  it("refuses a GET Request to the chat path", async () => {
    const { guard, calls } = setup();
    guard.setRouter(ROUTER_A);
    await expectBlocked(guard.fetch(new Request(`${ROUTER_A}/chat/completions`)), "https://api.example");
    expect(calls).toHaveLength(0);
  });

  // Fails if init's method does not override the Request's method, as the platform's fetch does.
  it("lets init's method override the Request's method", async () => {
    const { guard, calls } = setup();
    guard.setRouter(ROUTER_A);
    const request = new Request(`${ROUTER_A}/models`, { method: "POST", body: "x" });
    await expectBlocked(guard.fetch(request), "https://api.example");
    await guard.fetch(new Request(`${ROUTER_A}/chat/completions`), { method: "POST", body: "{}" });
    expect(effective(calls[0]).method).toBe("POST");
    expect(calls).toHaveLength(1);
  });

  // Fails if a same-origin artifact Request keeps redirect "follow".
  it("sets redirect error on a same-origin artifact Request", async () => {
    const { guard, calls } = setup();
    await guard.fetch(new Request(`${PAGE}/p/abc/agent-manifest.json`, { redirect: "follow" }));
    expect(effective(calls[0]).redirect).toBe("manual");
  });
});

describe("installFetchGuard", () => {
  // Fails if uninstall restores the original while another preview still holds the guard, or never restores it.
  it("counts references and restores the original at zero", async () => {
    const { guard } = setup();
    const pageFetch = async () => new Response("page");
    const target: { fetch: typeof fetch } = { fetch: pageFetch };
    const releaseOne = installFetchGuard(target, guard);
    const releaseTwo = installFetchGuard(target, guard);
    expect(target.fetch).toBe(guard.fetch);
    releaseOne();
    expect(target.fetch).toBe(guard.fetch);
    releaseOne();
    expect(target.fetch).toBe(guard.fetch);
    releaseTwo();
    expect(target.fetch).toBe(pageFetch);
  });

  // Fails if the installed fetch is not the guard (a third origin would reach the page's fetch).
  it("routes the target's fetch through the guard", async () => {
    const { guard, calls } = setup();
    const target: { fetch: typeof fetch } = { fetch: async () => new Response("page") };
    const release = installFetchGuard(target, guard);
    await expectBlocked(target.fetch(`${THIRD}/x`), THIRD);
    expect(calls).toHaveLength(0);
    release();
  });

  // Fails if a second guard silently replaces the installed one (reboot must reuse the installed guard).
  it("refuses a different guard while one is installed", () => {
    const first = setup().guard;
    const second = setup().guard;
    const target: { fetch: typeof fetch } = { fetch: async () => new Response("page") };
    const release = installFetchGuard(target, first);
    expect(() => installFetchGuard(target, second)).toThrow(Error);
    release();
    const releaseSecond = installFetchGuard(target, second);
    expect(target.fetch).toBe(second.fetch);
    releaseSecond();
  });
});

describe("state", () => {
  // Fails if state() exposes the live sets, so a caller could approve a peer without consent.
  it("returns a snapshot that does not change the guard", async () => {
    const { guard, calls } = setup();
    guard.setPolicyPeers([PEER_A]);
    const snapshot = guard.state();
    (snapshot.approvedPeers as string[]).push(PEER_A);
    await expectBlocked(guard.fetch(`${PEER_A}/x`), PEER_A);
    expect(calls).toHaveLength(0);
  });
});

describe("redirects on guarded requests", () => {
  // Fails if a guarded request follows or passes on a redirect instead of refusing it with the visitor text.
  it("refuses a redirect answer with the redirect text and never follows it", async () => {
    const { REDIRECT_BLOCKED_TEXT } = await import("@/lib/preview/fetch-guard");
    const seen: string[] = [];
    const recorder = async (input: RequestInfo | URL) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return new Response(null, { status: 302, headers: { location: "http://third.example/x" } });
    };
    const guard = createFetchGuard({ pageOrigin: "https://retrofit.example", originalFetch: recorder as typeof fetch });
    await expect(guard.fetch("https://retrofit.example/p/abc/agent-manifest.json")).rejects.toThrow(REDIRECT_BLOCKED_TEXT("https://retrofit.example"));
    expect(seen).toEqual(["https://retrofit.example/p/abc/agent-manifest.json"]);
  });
});

describe("runtime generations (V08)", () => {
  const FREE = `${PAGE}/api/inference/v1`;

  /** A recorder whose answers wait until the test releases them; it keeps each call's signal. */
  function holding() {
    const calls: { url: string; signal: AbortSignal | undefined; release: () => void }[] = [];
    const originalFetch = (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal ?? undefined;
        const url = new Request(input, init).url;
        calls.push({ url, signal, release: () => resolve(new Response("late")) });
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    const guard = createFetchGuard({ pageOrigin: PAGE, originalFetch, log: () => {} });
    return { guard, calls };
  }

  // Fails if setRouter gives the runtime the bare router (requests of two runtimes would look the same).
  it("gives each runtime its own base under the router", () => {
    const { guard } = setup();
    const first = guard.setRouter(FREE);
    const second = guard.setRouter(FREE);
    expect(first).toMatch(new RegExp(`^${FREE}/~retrofit-run-\\d+$`));
    expect(second).toMatch(new RegExp(`^${FREE}/~retrofit-run-\\d+$`));
    expect(second).not.toBe(first);
    expect(guard.setRouter(null)).toBeNull();
  });

  // Fails if the active runtime's free-path request is not sent to the real router path, or loses its body and headers.
  it("sends the active runtime's same-origin inference to the router path", async () => {
    const { guard, calls } = setup();
    const base = guard.setRouter(FREE)!;
    await guard.fetch(`${base}/chat/completions`, { method: "POST", body: "{\"m\":1}", headers: { "content-type": "application/json" } });
    await guard.fetch(`${base}/models`);
    const sent = calls.map(effective);
    expect(sent.map((r) => r.url)).toEqual([`${FREE}/chat/completions`, `${FREE}/models`]);
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.headers.get("content-type")).toBe("application/json");
    expect(await sent[0]!.text()).toBe('{"m":1}');
  });

  // Fails if a cross-origin runtime base is not mapped to the router, or skips the router's limits and redirect error.
  it("maps a cross-origin runtime base to the router and keeps the router's limits", async () => {
    const { guard, calls } = setup();
    const base = guard.setRouter(ROUTER_A)!;
    await guard.fetch(`${base}/chat/completions`, { method: "POST", body: "{}" });
    expect(effective(calls[0]).url).toBe(`${ROUTER_A}/chat/completions`);
    expect(effective(calls[0]).redirect).toBe("manual");
    await expectBlocked(guard.fetch(`${base}/chat/completions`), "https://api.example");
    expect(calls).toHaveLength(1);
  });

  // The V08 defect: after a switch, a retired free runtime's next model call still reached the free path.
  it("refuses a retired runtime's same-origin inference after the router changes", async () => {
    const { guard, calls } = setup();
    const oldBase = guard.setRouter(FREE)!;
    guard.setRouter(ROUTER_A);
    await expect(guard.fetch(`${oldBase}/chat/completions`, { method: "POST", body: "{}" })).rejects.toThrow(RETIRED_TEXT);
    // The same router again is a new runtime: the old base stays retired.
    const newBase = guard.setRouter(FREE)!;
    await expect(guard.fetch(`${oldBase}/chat/completions`, { method: "POST", body: "{}" })).rejects.toThrow(RETIRED_TEXT);
    await guard.fetch(`${newBase}/chat/completions`, { method: "POST", body: "{}" });
    expect(calls.map((c) => effective(c).url)).toEqual([`${FREE}/chat/completions`]);
  });

  // Fails if a runtime base for one router is accepted under another router, or a forged generation passes.
  it("refuses a run marker under another base or with an unknown generation", async () => {
    const { guard, calls } = setup();
    const base = guard.setRouter(FREE)!;
    const marker = base.slice(FREE.length);
    await expect(guard.fetch(`${PAGE}/api/other${marker}/chat/completions`, { method: "POST" })).rejects.toThrow(RETIRED_TEXT);
    await expect(guard.fetch(`${FREE}/~retrofit-run-999999/chat/completions`, { method: "POST" })).rejects.toThrow(RETIRED_TEXT);
    expect(calls).toHaveLength(0);
  });

  // Fails if a delayed model response of a retired runtime can still arrive (its tool calls would continue the loop).
  it("aborts a retired runtime's request that is still waiting for its answer", async () => {
    const { guard, calls } = holding();
    const base = guard.setRouter(FREE)!;
    const pending = guard.fetch(`${base}/chat/completions`, { method: "POST", body: "{}" });
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    guard.setRouter(ROUTER_A);
    await expect(pending).rejects.toThrow(RETIRED_TEXT);
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  // Fails if the guard drops the runtime's own abort signal (the runtime steers by aborting a model call).
  it("keeps the caller's abort signal on an active runtime's request", async () => {
    const { guard, calls } = holding();
    const base = guard.setRouter(FREE)!;
    const caller = new AbortController();
    const pending = guard.fetch(`${base}/chat/completions`, { method: "POST", body: "{}", signal: caller.signal });
    await Promise.resolve();
    caller.abort(new Error("steered"));
    await expect(pending).rejects.toThrow("steered");
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  // Fails if retiring a runtime also aborts ordinary same-origin requests (score polling, the session renewal).
  it("does not abort other same-origin requests when a runtime retires", async () => {
    const { guard, calls } = holding();
    guard.setRouter(FREE);
    const pending = guard.fetch(`${PAGE}/api/inference/session`, { method: "POST" });
    await Promise.resolve();
    guard.setRouter(null);
    calls[0]!.release();
    await expect(pending).resolves.toBeInstanceOf(Response);
  });
});
