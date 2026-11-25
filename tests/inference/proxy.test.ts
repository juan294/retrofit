import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_MESSAGE, UNAVAILABLE_MESSAGE } from "@/lib/inference/errors";
import { createHold } from "@/lib/inference/hold";
import { createLedger } from "@/lib/inference/ledger";
import { FREE_FAILED_MESSAGE, OVERRUN_ALERT_TIMEOUT_MS, handleChat, handleModels, handleStatus } from "@/lib/inference/proxy";
import { capMessage } from "@/lib/inference/quota";
import { reservationFor, usageCharge } from "@/lib/inference/reservation";
import { parseChatRequest } from "@/lib/inference/schema";
import { handleJudgeUpgrade, handleSession, sessionTexts } from "@/lib/inference/session";
import { alertStoreKey } from "@/lib/ops/alert";
import { GITHUB_TOKEN, ISSUES_URL } from "../helpers/ops";
import { captureConsole, cookieFrom, fakeClock, PUBLIC_ORIGIN, postRequest, testDeps, waitFor, type RequestOptions, type TestDeps } from "../helpers/server-deps";

const UPSTREAM = "https://upstream.test/v1";
const CHAT_URL = `${UPSTREAM}/chat/completions`;
const KEY_PUBLIC = "otk_public0a9e7b3d4c2a8e6f1b0d9c7a5e3f";
const KEY_JUDGE = "otk_judge7c1d2e3f4a5b6c7d8e9f0a1b2c3d4";
const JUDGE_CODE = "judge-code-7f3a91c2";
const PROVIDER_BEARER = "sk-proj-Visitor0123456789abcdefABCDEF";

const fixturesDir = fileURLToPath(new URL("../fixtures/runtime-requests/", import.meta.url));
const fixtureBodies: { file: string; index: number; body: Record<string, unknown> }[] = fs
  .readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .flatMap((file) => (JSON.parse(fs.readFileSync(path.join(fixturesDir, file), "utf8")) as { bodies: Record<string, unknown>[] }).bodies.map((body, index) => ({ file, index, body })));
const BODY = fixtureBodies[0]!.body;

// --- The network boundary ---

interface UpstreamCall {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal | null;
}

type Script = (call: UpstreamCall) => Promise<Response>;

let upstream: UpstreamCall[];
let issues: { title: string }[];
let script: Script;
let logs: string[];

const sse = (events: unknown[], done = true): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");

const contentEvent = (text: string) => ({ id: "c1", object: "chat.completion.chunk", model: "alibaba/qwen3.8-flash", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
const finishEvent = (reason = "stop") => ({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageEvent = (prompt = 120, completion = 20) => ({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } });

const ANSWER = "Our opening hours are 7:00 to 18:00.";
const complete = (usage = usageEvent()) => sse([contentEvent(ANSWER), finishEvent(), usage]);

/** A streamed response whose chunks arrive in order; `then: "break"` errors the stream after them, `"hang"` never ends it. */
function streamed(chunks: string[], then: "end" | "break" | "hang" = "end", signal?: AbortSignal | null): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (then === "end") controller.close();
      if (then === "hang") signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
    // Errors only after the queued chunks were read (an error in start would discard them).
    pull(controller) {
      if (then === "break") controller.error(new Error("socket hang up"));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Resolves only when `signal` aborts, then rejects like fetch does. */
const hang = (signal: AbortSignal | null) =>
  new Promise<Response>((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")), { once: true });
  });

beforeEach(() => {
  upstream = [];
  issues = [];
  logs = [];
  script = async () => streamed([complete()]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === ISSUES_URL) {
        issues.push(JSON.parse(String(init?.body)) as { title: string });
        return new Response(JSON.stringify({ number: issues.length }), { status: 201 });
      }
      if (url !== CHAT_URL) throw new Error(`unexpected network call to ${url}`);
      const call: UpstreamCall = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown>, signal: init?.signal ?? null };
      upstream.push(call);
      return script(call);
    }),
  );
  captureConsole(logs);
});

afterEach(() => {
  // No part of a server key, a provider Bearer or a session token in any log line (redaction.test.ts has the unit cases).
  const all = logs.join("\n");
  for (const secret of [KEY_PUBLIC, KEY_JUDGE, PROVIDER_BEARER]) {
    for (let i = 0; i + 8 <= secret.length; i++) expect(all).not.toContain(secret.slice(i, i + 8));
  }
  for (const t of tokens) expect(all).not.toContain(t.split(".")[1]!.slice(0, 12));
  tokens = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Requests ---

let tokens: string[] = [];

function setup(env: Record<string, string> = {}, store?: TestDeps["store"]) {
  const clock = fakeClock();
  const d = testDeps({
    clock: clock.clock,
    store,
    env: { FREE_UPSTREAM_URL: UPSTREAM, OTARI_API_KEY_PUBLIC: KEY_PUBLIC, OTARI_API_KEY_JUDGE: KEY_JUDGE, JUDGE_CODE, ALERT_GITHUB_TOKEN: GITHUB_TOKEN, ...env },
  });
  return { d, clock, ledger: createLedger({ store: d.store, config: d.config.free, clock: d.clock }) };
}

async function session(d: TestDeps, judge = false): Promise<string> {
  const res = await handleSession(postRequest("/api/inference/session", undefined), d);
  expect(res.status).toBe(200);
  let cookie = cookieFrom(res);
  if (judge) {
    const up = await handleJudgeUpgrade(postRequest("/api/inference/session/judge", { code: JUDGE_CODE }, { cookie }), d);
    expect(up.status).toBe(200);
    cookie = cookieFrom(up);
  }
  tokens.push(cookie.slice(cookie.indexOf("=") + 1));
  return cookie;
}

/** `auth` defaults to the placeholder Bearer; null sends no Authorization. */
type ChatOpts = Omit<RequestOptions, "auth"> & { auth?: string | null };

const chat = (body: unknown, o: ChatOpts = {}): Request =>
  postRequest("/api/inference/v1/chat/completions", body, { ...o, auth: o.auth === null ? undefined : (o.auth ?? "Bearer retrofit-free") });

/** Reads the body the way the runtime does (`runtime/llm.js` `_readSse`). */
function readLikeRuntime(text: string) {
  let content = "";
  let finishReason: string | null = null;
  let usage: unknown = null;
  let done = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    const json = JSON.parse(payload) as { usage?: unknown; choices?: { delta?: { content?: string }; finish_reason?: string | null }[] };
    if (json.usage) usage = json.usage;
    const choice = json.choices?.[0];
    if (!choice) continue;
    if (choice.delta?.content) content += choice.delta.content;
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  return { content, finishReason, usage, done };
}

async function errorOf(res: Response): Promise<{ message: string; type: string; code: string }> {
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = (await res.json()) as { error: { message: string; type: string; code: string } };
  expect(Object.keys(body.error).sort()).toEqual(["code", "message", "type"]);
  return body.error;
}

const reservationOf = (d: TestDeps, body: unknown) => {
  const parsed = parseChatRequest(body, d.config.free);
  if (!parsed.ok) throw new Error(parsed.message);
  return reservationFor(parsed.body, d.config.free).microUsd;
};

// --- Tests ---

describe("POST /api/inference/v1/chat/completions: forwarding", () => {
  // Fails if the proxy forwards the visitor's Bearer or cookie, uses the wrong pool's key, or answers anything but one buffered SSE body.
  it("sends the server key upstream, no cookie, and returns the buffered events as one SSE body", async () => {
    const { d } = setup();
    const cookie = await session(d);
    const res = await handleChat(chat(BODY, { cookie }), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(upstream).toHaveLength(1);
    const call = upstream[0]!;
    expect(call.headers.get("authorization")).toBe(`Bearer ${KEY_PUBLIC}`);
    expect(call.headers.get("cookie")).toBeNull();
    const text = await res.text();
    expect(readLikeRuntime(text)).toEqual({ content: ANSWER, finishReason: "stop", usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 }, done: true });
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  // Fails if a judge session is served with the public key.
  it("uses the judge key for a judge session", async () => {
    const { d } = setup();
    const cookie = await session(d, true);
    expect((await handleChat(chat(BODY, { cookie }), d)).status).toBe(200);
    expect(upstream[0]!.headers.get("authorization")).toBe(`Bearer ${KEY_JUDGE}`);
  });

  // Fails if the upstream body lacks a forced field or keeps a visitor value for it.
  it("forces n 1, stream, include_usage, max_tokens and the free model upstream", async () => {
    const { d } = setup();
    const cookie = await session(d);
    await handleChat(chat({ ...BODY, stream: false, temperature: 0.2 }, { cookie }), d);
    const body = upstream[0]!.body;
    expect(body).toMatchObject({ model: d.config.free.model, n: 1, stream: true, stream_options: { include_usage: true }, max_tokens: 1024, temperature: 0.2 });
    expect(body.messages).toEqual(BODY.messages);
    expect(body.tools).toEqual(BODY.tools);
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "n", "stream", "stream_options", "temperature", "tool_choice", "tools"]);
  });

  // Fails if any request the vendored runtime sends is refused or not forwarded unchanged.
  it.each(fixtureBodies.map((f) => [`${f.file} #${f.index + 1}`, f.body] as const))("replays the runtime body %s with 200", async (_name, body) => {
    const { d } = setup();
    const cookie = await session(d);
    const res = await handleChat(chat(body, { cookie }), d);
    expect(res.status).toBe(200);
    expect(readLikeRuntime(await res.text()).content).toBe(ANSWER);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.body.messages).toEqual(body.messages);
  });

  // Fails if a reconciled call is not charged at its reported usage.
  it("reconciles the reservation to the reported usage", async () => {
    const { d, ledger } = setup();
    const cookie = await session(d);
    await handleChat(chat(BODY, { cookie }), d);
    const b = await ledger.budgets();
    expect(b.totalOutstandingMicro).toBe(0);
    expect(b.totalSpentMicro).toBe(Math.ceil(120 * 0.1 + 20 * 0.4 - 1e-9));
  });
});

describe("chat: refusals before any upstream call", () => {
  // Fails if n or logprobs reaches the provider (cost and output-shape control).
  it.each([["n", 2], ["logprobs", true]])("refuses %s with 400", async (field, value) => {
    const { d } = setup();
    const cookie = await session(d);
    const res = await handleChat(chat({ ...BODY, [field]: value }, { cookie }), d);
    expect(res.status).toBe(400);
    const e = await errorOf(res);
    expect(e.message).toContain(`"${field}"`);
    expect(e.type).toBe("invalid_request_error");
    expect(upstream).toHaveLength(0);
  });

  // Fails if a prototype-named role escapes the schema as an internal error instead of a 400 refusal (V09).
  it.each(["__proto__", "constructor", "toString"])("refuses the role %j with 400 and no upstream call", async (role) => {
    const { d } = setup();
    const cookie = await session(d);
    const res = await handleChat(chat({ ...BODY, messages: [{ role, content: "x" }] }, { cookie }), d);
    expect(res.status).toBe(400);
    const e = await errorOf(res);
    expect(e.type).toBe("invalid_request_error");
    expect(e.message).toMatch(/role must be system, user, assistant or tool/);
    expect(upstream).toHaveLength(0);
  });

  // Fails if the body limit is applied after JSON parsing (the refusal must name the size, even for a body that is not JSON).
  it("refuses an oversize body before parsing it", async () => {
    const { d } = setup();
    const cookie = await session(d);
    const res = await handleChat(chat("x".repeat(d.config.free.maxBodyBytes + 1), { cookie }), d);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain(`larger than ${d.config.free.maxBodyBytes} bytes`);
    const big = { ...BODY, messages: [...(BODY.messages as unknown[]), { role: "user", content: "y".repeat(d.config.free.maxBodyBytes) }] };
    expect((await handleChat(chat(big, { cookie }), d)).status).toBe(400);
    expect(upstream).toHaveLength(0);
  });

  // Fails if the message or tool limits are not enforced on the proxy path.
  it("refuses too many messages, too many tools and a too large tool", async () => {
    const { d } = setup();
    const cookie = await session(d);
    const tool = (name: string, description = "Does a thing.") => ({ type: "function", function: { name, description, parameters: { type: "object", properties: {} } } });
    const messages = Array.from({ length: d.config.free.maxMessages + 1 }, (_, i) => ({ role: "user", content: `m${i}` }));
    const cases = [
      { ...BODY, messages },
      { ...BODY, tools: Array.from({ length: d.config.free.maxTools + 1 }, (_, i) => tool(`t${i}`)) },
      { ...BODY, tools: [tool("big", "d".repeat(d.config.free.maxToolBytes))] },
    ];
    const texts = [];
    for (const body of cases) {
      const res = await handleChat(chat(body, { cookie }), d);
      expect(res.status).toBe(400);
      texts.push((await errorOf(res)).message);
    }
    expect(texts[0]).toContain("Too many messages");
    expect(texts[1]).toContain("Too many tools");
    expect(texts[2]).toContain(`larger than ${d.config.free.maxToolBytes} bytes`);
    expect(upstream).toHaveLength(0);
  });

  // Fails if a cross-origin page can spend the free path with the visitor's cookie.
  it("refuses a cross-origin request", async () => {
    const { d } = setup();
    const cookie = await session(d);
    const res = await handleChat(chat(BODY, { cookie, fetchSite: "cross-site", origin: "https://evil.test" }), d);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toBe(sessionTexts.crossOrigin);
    expect((await handleChat(chat(BODY, { cookie, fetchSite: null }), d)).status).toBe(403);
    expect(upstream).toHaveLength(0);
  });

  // Fails if a visitor's provider key sent to this endpoint is forwarded, accepted or logged.
  it("refuses a provider-looking Bearer and forwards nothing", async () => {
    const { d } = setup();
    const cookie = await session(d);
    for (const auth of [`Bearer ${PROVIDER_BEARER}`, "Bearer otk_visitorkey0123456789", null, "Basic retrofit-free", "Bearer retrofit-free extra"]) {
      const res = await handleChat(chat(BODY, { cookie, auth }), d);
      expect(res.status).toBe(401);
      expect((await errorOf(res)).type).toBe("authentication_error");
    }
    expect(upstream).toHaveLength(0);
  });

  // Fails if a request with no valid session is forwarded.
  it("refuses a missing or invalid session with the expired text", async () => {
    const { d } = setup();
    for (const cookie of [undefined, "retrofit_session=forged.token"]) {
      const res = await handleChat(chat(BODY, { cookie }), d);
      expect(res.status).toBe(401);
      expect((await errorOf(res)).message).toBe(sessionTexts.expired);
    }
    expect(upstream).toHaveLength(0);
  });

  // Fails if the proxy forwards with no server key or reserves spend it cannot use.
  it("answers 503 when no server key is configured for the pool", async () => {
    const clock = fakeClock();
    const d = testDeps({ clock: clock.clock, env: { FREE_UPSTREAM_URL: UPSTREAM } });
    const cookie = await session(d);
    const res = await handleChat(chat(BODY, { cookie }), d);
    expect(res.status).toBe(503);
    expect((await errorOf(res)).message).toBe(UNAVAILABLE_MESSAGE);
    expect(upstream).toHaveLength(0);
    expect((await createLedger({ store: d.store, config: d.config.free, clock: d.clock }).budgets()).totalOutstandingMicro).toBe(0);
  });

  // Fails if the proxy forwards when the quota or ledger store fails (no forwarding without a reservation).
  it.each([["quota", "inference:quota:"], ["ledger", "inference:ledger:"]])("answers 503 when the %s counters are unavailable, with no upstream call", async (_name, prefix) => {
    let broken = false;
    const clock = fakeClock();
    const d = testDeps({
      clock: clock.clock,
      env: { FREE_UPSTREAM_URL: UPSTREAM, OTARI_API_KEY: KEY_PUBLIC },
      instrument: (_op, key) => {
        if (broken && key.startsWith(prefix)) throw new Error("store down");
      },
    });
    const cookie = await session(d);
    broken = true;
    const res = await handleChat(chat(BODY, { cookie }), d);
    expect(res.status).toBe(503);
    expect((await errorOf(res)).message).toBe(UNAVAILABLE_MESSAGE);
    expect(upstream).toHaveLength(0);
  });

  // Fails if the session call cap is not applied on the proxy path, or answers with other text.
  it("answers 429 with the cap text at call N+1", async () => {
    const { d } = setup({ FREE_CALLS_PER_SESSION: "1" });
    const cookie = await session(d);
    expect((await handleChat(chat(BODY, { cookie }), d)).status).toBe(200);
    const res = await handleChat(chat(BODY, { cookie }), d);
    expect(res.status).toBe(429);
    expect((await errorOf(res)).message).toBe(capMessage("session_calls"));
    expect(upstream).toHaveLength(1);
  });

  // Fails if the network's judge limit is not applied on the proxy path, or counts by session or by a header that a client can choose freely.
  it("another judge session of the same network meets the network's daily limit", async () => {
    const { d } = setup({ JUDGE_CALLS_PER_CLIENT_DAY: "2" });
    const [a, b] = [await session(d, true), await session(d, true)];
    expect(a).not.toBe(b);
    expect((await handleChat(chat(BODY, { cookie: a }), d)).status).toBe(200);
    expect((await handleChat(chat(BODY, { cookie: b }), d)).status).toBe(200);
    const res = await handleChat(chat(BODY, { cookie: b }), d);
    expect(res.status).toBe(429);
    const text = await res.text();
    expect(text.length).toBeLessThanOrEqual(300);
    expect((JSON.parse(text) as { error: { code: string; message: string } }).error).toMatchObject({ code: "judge_network_calls", message: expect.not.stringMatching(/key/i) });
    expect(upstream).toHaveLength(2);
  });

  // UX-H3. Fails if the judge's daily limit is not applied on the proxy path, reaches the provider, sends the judge to a
  // paid key or names no retry time, or ends judge access after the day.
  it("a judge's daily call limit answers 429 with the retry time, and opens at 00:00 UTC", async () => {
    const { d, clock } = setup({ JUDGE_CALLS_PER_SESSION_DAY: "1" });
    const cookie = await session(d, true);
    expect((await handleChat(chat(BODY, { cookie }), d)).status).toBe(200);
    const res = await handleChat(chat(BODY, { cookie }), d);
    expect([res.status, res.headers.get("retry-after")]).toEqual([429, String((Date.parse("2026-11-16T00:00:00Z") - clock.now()) / 1000)]);
    const text = await res.text();
    const body = JSON.parse(text) as { error: { message: string; code: string }; retryAt: string };
    expect(body.error.code).toBe("judge_session_calls");
    expect(body.error.message).toMatch(/00:00 UTC on 16 November 2026\.$/);
    expect(body.error.message).not.toMatch(/key/i);
    expect(body.retryAt).toBe("2026-11-16T00:00:00.000Z");
    // The runtime cuts an error body at 300 characters; the chat then could not show the message.
    expect(text.length).toBeLessThanOrEqual(300);
    expect(await (await handleStatus(new Request(`${PUBLIC_ORIGIN}/api/inference/status`, { headers: { cookie } }), d)).json()).toMatchObject({ available: false, pool: "judge", reason: "judge_session_calls" });
    expect(upstream).toHaveLength(1);
    clock.set(Date.parse("2026-11-16T00:00:00Z"));
    expect(await (await handleStatus(new Request(`${PUBLIC_ORIGIN}/api/inference/status`, { headers: { cookie } }), d)).json()).toMatchObject({ available: true, pool: "judge" });
    expect((await handleChat(chat(BODY, { cookie }), d)).status).toBe(200);
  });

  // Fails if a provider failure sends a judge to a paid key while the reserve has money.
  it("a failed call asks a judge to try again, without a key", async () => {
    const { d } = setup();
    const cookie = await session(d, true);
    script = async () => new Response("no", { status: 500 });
    const res = await handleChat(chat(BODY, { cookie }), d);
    expect([res.status, (await errorOf(res)).message]).toEqual([502, "The free AI provider did not answer. Try again."]);
  });

  // Fails if the money limit is not the hard cap for a judge, or its text hides the own-key way out then.
  it("an empty judge reserve refuses a judge before the provider, with the own-key text", async () => {
    const { d } = setup({ JUDGE_RESERVE_USD: "0.000001" });
    const cookie = await session(d, true);
    const res = await handleChat(chat(BODY, { cookie }), d);
    expect([res.status, (await errorOf(res)).message]).toEqual([429, capMessage("judge_pool")]);
    expect(upstream).toHaveLength(0);
  });

  // Fails if the reservation is not taken atomically before forwarding (both would reach the provider).
  it("two parallel requests when only one reservation fits give one 429", async () => {
    const probe = setup();
    const r = reservationOf(probe.d, BODY);
    // One UTC day left, so the public daily budget is the whole public part: 1.5 reservations.
    const { d } = setup({ FREE_SERVICE_END: "2026-11-15T23:59:59Z", JUDGE_RESERVE_USD: "1", FREE_CREDIT_USD: (1 + (1.5 * r) / 1e6).toFixed(6) });
    const cookie = await session(d);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    script = async () => {
      await gate;
      return streamed([complete()]);
    };
    const both = [handleChat(chat(BODY, { cookie }), d), handleChat(chat(BODY, { cookie }), d)];
    const first = await Promise.race(both);
    expect(first.status).toBe(429);
    expect((await errorOf(first)).message).toBe(capMessage("public_pool"));
    expect(upstream).toHaveLength(1);
    open();
    expect((await Promise.all(both)).map((x) => x.status).sort()).toEqual([200, 429]);
    expect(upstream).toHaveLength(1);
  });
});

describe("chat: upstream failures", () => {
  const failures: [string, Script][] = [
    ["upstream 500", async () => new Response('{"error":{"message":"internal: upstream secret detail"}}', { status: 500 })],
    ["partial content then a broken stream", async () => streamed([sse([contentEvent("Our opening hours")], false)], "break")],
    ["a stream with no finish_reason", async () => streamed([sse([contentEvent("Our opening hours"), usageEvent()])])],
    ["a stream with no usage", async () => streamed([sse([contentEvent("Our opening hours"), finishEvent()])])],
    ["a transport error", async () => Promise.reject(new TypeError("fetch failed"))],
  ];

  // Fails if any failure returns 200, leaks part of the answer or the upstream body, releases the reservation, or retries.
  it.each(failures)("%s gives 502 with recovery text, no partial content, the full reservation kept and no retry", async (_name, s) => {
    const { d, ledger } = setup();
    const cookie = await session(d);
    script = s;
    const res = await handleChat(chat(BODY, { cookie }), d);
    expect(res.status).toBe(502);
    const raw = await res.clone().text();
    expect(raw).not.toContain("opening hours");
    expect(raw).not.toContain("secret detail");
    const e = await errorOf(res);
    expect(e.message).toBe(FREE_FAILED_MESSAGE);
    expect(FREE_FAILED_MESSAGE).toBe("The free AI provider did not answer. Try again, or use your own key.");
    expect(upstream).toHaveLength(1);
    const b = await ledger.budgets();
    expect(b.totalSpentMicro + b.totalOutstandingMicro).toBe(reservationOf(d, BODY));
  });

  // Fails if the upstream timeout is missing for the headers or for the body (the request would hang past maxDuration).
  it.each([
    ["no response", (c: UpstreamCall) => hang(c.signal)],
    // The stalled body ignores the abort signal, so only the proxy's own deadline can end the read.
    ["a stream that stalls after partial content", async () => streamed([sse([contentEvent("Our opening hours")], false)], "hang")],
  ] as [string, Script][])("times out on %s with 502 and aborts upstream", async (_name, s) => {
    const { d } = setup({ FREE_UPSTREAM_TIMEOUT_MS: "40" });
    const cookie = await session(d);
    script = s;
    const res = await handleChat(chat(BODY, { cookie }), d);
    expect(res.status).toBe(502);
    const raw = await res.text();
    expect(raw).not.toContain("opening hours");
    expect(raw).toContain(FREE_FAILED_MESSAGE);
    expect(upstream[0]!.signal?.aborted).toBe(true);
    expect(upstream).toHaveLength(1);
  });

  // Fails if a visitor disconnect leaves the upstream request running, or releases the reservation.
  it("a visitor disconnect aborts upstream and keeps the reservation", async () => {
    const { d, ledger } = setup();
    const cookie = await session(d);
    script = (c) => hang(c.signal);
    const visitor = new AbortController();
    const pending = handleChat(chat(BODY, { cookie, signal: visitor.signal }), d);
    await waitFor(() => upstream.length === 1, "upstream call");
    expect(upstream[0]!.signal?.aborted).toBe(false);
    visitor.abort();
    const res = await pending;
    expect(res.status).toBe(502);
    const e = await errorOf(res);
    expect(e.code).toBe("visitor_disconnected");
    expect(e.message).toBe(FREE_FAILED_MESSAGE);
    expect(upstream[0]!.signal?.aborted).toBe(true);
    expect(upstream).toHaveLength(1);
    const b = await ledger.budgets();
    expect(b.totalSpentMicro + b.totalOutstandingMicro).toBe(reservationOf(d, BODY));
  });

  // Fails if the in-flight slots leak on failure (the session would be locked out after two failures).
  it("frees the in-flight slots after failures", async () => {
    const { d } = setup();
    const cookie = await session(d);
    script = async () => new Response("nope", { status: 500 });
    for (let i = 0; i < 3; i++) expect((await handleChat(chat(BODY, { cookie }), d)).status).toBe(502);
    script = async () => streamed([complete()]);
    expect((await handleChat(chat(BODY, { cookie }), d)).status).toBe(200);
  });
});

describe("chat: overrun hold", () => {
  // Fails if an overrun does not write the hold, opens no alert or more than one, or if the hold does not close the public pool.
  it("an overrun writes the hold, opens one alert, and the held public pool refuses while the judge pool serves", async () => {
    const { d } = setup();
    const publicCookie = await session(d);
    const judgeCookie = await session(d, true);
    script = async () => streamed([complete(usageEvent(500_000, 10))]);

    const res = await handleChat(chat(BODY, { cookie: publicCookie }), d);
    expect(res.status).toBe(200);
    expect(readLikeRuntime(await res.text()).content).toBe(ANSWER);
    const hold = await createHold({ store: d.store, config: d.config.free, clock: d.clock }).read();
    expect(hold).toMatchObject({ reason: "reservation_overrun", reservationMicroUsd: reservationOf(d, BODY) });
    expect(issues.map((i) => i.title)).toEqual(["Free AI reservation overrun"]);

    // A second overrun (judge pool) while held opens no second issue.
    expect((await handleChat(chat(BODY, { cookie: judgeCookie }), d)).status).toBe(200);
    expect(issues).toHaveLength(1);

    script = async () => streamed([complete()]);
    upstream = [];
    const held = await handleChat(chat(BODY, { cookie: publicCookie }), d);
    expect(held.status).toBe(429);
    expect((await errorOf(held)).message).toBe(HOLD_MESSAGE);
    expect(upstream).toHaveLength(0);

    expect((await handleChat(chat(BODY, { cookie: judgeCookie }), d)).status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(await d.store.get(alertStoreKey(`overrun:${Date.parse(hold!.at)}`))).toEqual({ state: "sent" });
  });

  // Fails if the proxy relies only on the ledger flag and ignores a hold record written by another path.
  it("a hold record alone closes the public pool", async () => {
    const { d } = setup();
    const cookie = await session(d);
    await d.store.set("inference:hold", { reason: "manual", at: new Date(d.clock()).toISOString(), overrunMicroUsd: 1, reservationMicroUsd: 1 }, 3600);
    const res = await handleChat(chat(BODY, { cookie }), d);
    expect(res.status).toBe(429);
    expect((await errorOf(res)).message).toBe(HOLD_MESSAGE);
    expect(upstream).toHaveLength(0);
  });
});

describe("GET /api/inference/v1/models and /api/inference/status", () => {
  // Fails if /models needs credentials (the runtime sends none) or lists any other model.
  it("/models lists only the free model without credentials", async () => {
    const { d } = setup();
    const res = handleModels(d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ object: "list", data: [{ id: d.config.free.model, object: "model", created: 0, owned_by: "retrofit" }] });
  });

  const statusReq = (cookie?: string) => new Request(`${PUBLIC_ORIGIN}/api/inference/status`, { headers: cookie ? { cookie } : {} });

  // Fails if status shows amounts, ignores the session, or does not count calls the proxy made.
  it("reports availability and pool without amounts; sid and calls only in fixtures mode", async () => {
    const { d } = setup();
    expect(await (await handleStatus(statusReq(), d)).json()).toEqual({ available: false, pool: null, reason: "no_session" });
    const cookie = await session(d);
    await handleChat(chat(BODY, { cookie }), d);
    const body = (await (await handleStatus(statusReq(cookie), d)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ available: true, pool: "public", reason: null, calls: 1, publicSpentTodayMicro: usageCharge({ promptTokens: 120, completionTokens: 20 }, d.config.free) });
    expect(body.sid).toMatch(/^[0-9a-f]{32}$/);

    // Fails if the fixtures-only fields (sid, calls, publicSpentTodayMicro) leak outside fixtures mode.
    const prod = setup({ RETROFIT_TEST_FIXTURES: "" });
    const prodCookie = await session(prod.d);
    await handleChat(chat(BODY, { cookie: prodCookie }), prod.d);
    const prodBody = (await (await handleStatus(statusReq(prodCookie), prod.d)).json()) as Record<string, unknown>;
    expect(prodBody).not.toHaveProperty("publicSpentTodayMicro");
    expect(prodBody).toEqual({ available: true, pool: "public", reason: null });
  });

  // Fails if status says the public pool is available during the overrun hold.
  it("reports the hold for a public session", async () => {
    const { d } = setup();
    const cookie = await session(d);
    await createHold({ store: d.store, config: d.config.free, clock: d.clock }).writeHold({ reason: "reservation_overrun", overrunMicroUsd: 1, reservationMicroUsd: 1 });
    expect(await (await handleStatus(statusReq(cookie), d)).json()).toMatchObject({ available: false, pool: "public", reason: "hold" });
  });
});

describe("chat: reported usage on failure and the input bound", () => {
  const holdOf = (d: TestDeps) => createHold({ store: d.store, config: d.config.free, clock: d.clock }).read();
  const big = () => usageEvent(500_000, 10);
  const bigCharge = (d: TestDeps) => usageCharge({ promptTokens: 500_000, completionTokens: 10 }, d.config.free);

  // P6-R1. Fails if a failed stream that reported usage is charged only the reservation, or skips the hold and alert on an overrun.
  it.each([
    ["usage but no finish_reason", () => streamed([sse([contentEvent("Our opening hours"), big()])])],
    ["usage and then a broken stream", () => streamed([sse([contentEvent("Our opening hours"), finishEvent(), big()], false)], "break")],
  ] as [string, () => Response][])("%s above the reservation: 502, charges the reported usage, holds and alerts once", async (_name, make) => {
    const { d, ledger } = setup();
    const cookie = await session(d);
    script = async () => make();
    const res = await handleChat(chat(BODY, { cookie }), d);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("opening hours");
    const b = await ledger.budgets();
    expect(b.totalOutstandingMicro).toBe(0);
    expect(b.totalSpentMicro).toBe(bigCharge(d));
    expect(await holdOf(d)).toMatchObject({ reason: "reservation_overrun", reservationMicroUsd: reservationOf(d, BODY) });
    expect(issues.map((i) => i.title)).toEqual(["Free AI reservation overrun"]);
  });

  // P6-R1. Fails if usage below the reservation on a failed stream lowers the charge (the provider may bill more than it reported so far).
  it("usage below the reservation on a broken stream charges the full reservation and does not hold", async () => {
    const { d, ledger } = setup();
    const cookie = await session(d);
    script = async () => streamed([sse([contentEvent("Our opening hours"), usageEvent(120, 20)], false)], "break");
    expect((await handleChat(chat(BODY, { cookie }), d)).status).toBe(502);
    expect((await ledger.budgets()).totalSpentMicro).toBe(reservationOf(d, BODY));
    expect(await holdOf(d)).toBeNull();
    expect(issues).toHaveLength(0);
  });

  // P6-R4. Fails if prompt tokens above the input bound pass unnoticed because the unused output allowance hides them in the total.
  it("prompt tokens above the input bound hold the pool even when the charge fits the reservation", async () => {
    const { d, ledger } = setup();
    const cookie = await session(d);
    const parsed = parseChatRequest(BODY, d.config.free);
    if (!parsed.ok) throw new Error(parsed.message);
    const bound = reservationFor(parsed.body, d.config.free);
    script = async () => streamed([complete(usageEvent(bound.inputTokenBound + 1, 0))]);
    const res = await handleChat(chat(BODY, { cookie }), d);
    expect(res.status).toBe(200);
    expect((await ledger.budgets()).totalSpentMicro).toBeLessThan(bound.microUsd);
    expect(await holdOf(d)).toMatchObject({ reason: "input_tokens_above_bound", overrunMicroUsd: 0, reservationMicroUsd: bound.microUsd });
    expect(issues.map((i) => i.title)).toEqual(["Free AI reservation overrun"]);
    expect((await handleChat(chat(BODY, { cookie }), d)).status).toBe(429);
  });

  // P6-R7. Fails if the overrun alert uses the 10 s default GitHub timeout (45 s upstream + 10 s could pass maxDuration 60 s).
  it("bounds the overrun GitHub call to 5 s", async () => {
    const { d } = setup();
    const cookie = await session(d);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    script = async () => streamed([complete(big())]);
    expect((await handleChat(chat(BODY, { cookie }), d)).status).toBe(200);
    expect(OVERRUN_ALERT_TIMEOUT_MS).toBeLessThanOrEqual(5000);
    expect(timeout).toHaveBeenCalledWith(OVERRUN_ALERT_TIMEOUT_MS);
    expect(timeout).not.toHaveBeenCalledWith(10_000);
  });
});
