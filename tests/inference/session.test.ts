import { afterEach, describe, expect, it, vi } from "vitest";
import { handleJudgeUpgrade, handleSession, JUDGE_ATTEMPTS_PER_CLIENT_HOUR, JUDGE_SESSION_TTL_S, readSession, sessionKey, sessionTexts } from "@/lib/inference/session";
import { unavailableText } from "@/components/preview/useFreeSession";
import { verifySession } from "@/lib/inference/token";
import { captureConsole, cookieFrom, fakeClock, PUBLIC_ORIGIN, postRequest, storeDump, testDeps, type RequestOptions } from "../helpers/server-deps";

const CODE = "judge-code-7f3a91c2";

const sessionReq = (o: RequestOptions = {}) => postRequest("/api/inference/session", undefined, o);
const judgeReq = (body: unknown, o: RequestOptions = {}) => postRequest("/api/inference/session/judge", body, o);

const tokenOf = (res: Response) => cookieFrom(res).replace(/^retrofit_session=/, "");

function setup(env: Record<string, string> = {}) {
  const clock = fakeClock();
  const d = testDeps({ clock: clock.clock, env: { JUDGE_CODE: CODE, ...env } });
  const claimsOf = (res: Response) => verifySession(tokenOf(res), d.config.sessionSecret, clock.now());
  return { d, clock, claimsOf };
}

afterEach(() => vi.restoreAllMocks());

describe("POST /api/inference/session", () => {
  // Fails if any cookie attribute is missing, wrong or extra (Path, SameSite, Max-Age, Secure on HTTPS).
  it("creates a public session with the exact cookie attributes", async () => {
    const { d, claimsOf, clock } = setup();
    const res = await handleSession(sessionReq(), d);
    expect(res.status).toBe(200);
    const parts = res.headers.get("set-cookie")!.split(";").map((s) => s.trim());
    expect(parts[0]).toMatch(/^retrofit_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(parts.slice(1).sort()).toEqual(["HttpOnly", "Max-Age=7200", "Path=/api/inference", "SameSite=Strict", "Secure"]);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ pool: "public", expiresAt: new Date(clock.now() + 7200_000).toISOString() });
    const claims = claimsOf(res)!;
    expect(claims.pool).toBe("public");
    expect(await d.store.get(sessionKey(claims.sid))).toEqual({ version: 1, pool: "public", createdAt: clock.now() });
  });

  // Fails if Secure is set on a plain-HTTP local origin.
  it("omits Secure on plain HTTP", async () => {
    const clock = fakeClock();
    const d = testDeps({ clock: clock.clock, env: { PUBLIC_ORIGIN: "http://127.0.0.1:3010" } });
    const req = new Request("http://127.0.0.1:3010/api/inference/session", { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
    const res = await handleSession(req, d);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
  });

  // Fails if renewal mints a new sid, or does not extend the expiry and the stored record's TTL.
  it("renews a valid cookie with the same sid and pool", async () => {
    const { d, clock, claimsOf } = setup();
    const first = await handleSession(sessionReq(), d);
    const c1 = claimsOf(first)!;
    // A counter another module keeps under the sid survives renewal.
    await d.store.incrementWindow(`inference:test-counter:${c1.sid}`, 86_400, 5);

    clock.advance(90 * 60_000);
    const renewed = await handleSession(sessionReq({ cookie: cookieFrom(first) }), d);
    expect(renewed.status).toBe(200);
    const c2 = claimsOf(renewed)!;
    expect(c2).toMatchObject({ sid: c1.sid, pool: "public", client: c1.client, exp: clock.now() + 7200_000 });
    expect(((await renewed.json()) as { pool: string }).pool).toBe("public");
    expect(await d.store.incrementWindow(`inference:test-counter:${c1.sid}`, 86_400, 0)).toBe(5);

    // The stored record was renewed: it outlives the original two hours.
    clock.advance(60 * 60_000);
    expect(await readSession(sessionReq({ cookie: cookieFrom(renewed) }), d)).toEqual({ claims: expect.objectContaining({ sid: c1.sid, pool: "public" }) });
  });

  // Fails if renewals count against the per-client cap, or new sessions are not capped.
  it("applies the per-client cap only to new sessions", async () => {
    const { d } = setup({ FREE_SESSIONS_PER_CLIENT_HOUR: "2" });
    const a = await handleSession(sessionReq(), d);
    const b = await handleSession(sessionReq(), d);
    expect([a.status, b.status]).toEqual([200, 200]);
    for (let i = 0; i < 5; i++) expect((await handleSession(sessionReq({ cookie: cookieFrom(a) }), d)).status).toBe(200);
    const third = await handleSession(sessionReq(), d);
    expect(third.status).toBe(429);
    const body = (await third.json()) as { error: string; message: string; retryAt: string };
    expect(body.error).toBe("session_limit");
    expect(body.message).toContain("Use your own AI key to continue.");
    expect(third.headers.get("set-cookie")).toBeNull();
    // Another client is not affected.
    expect((await handleSession(sessionReq({ ip: "198.51.100.20" }), d)).status).toBe(200);
  });

  // Fails if a tampered or expired cookie is renewed instead of treated as a new session.
  it("treats an invalid cookie as no session", async () => {
    const { d, clock, claimsOf } = setup();
    const first = await handleSession(sessionReq(), d);
    const sid = claimsOf(first)!.sid;
    clock.advance(7200_000);
    const later = await handleSession(sessionReq({ cookie: cookieFrom(first) }), d);
    expect(later.status).toBe(200);
    expect(claimsOf(later)!.sid).not.toBe(sid);
    const forged = await handleSession(sessionReq({ cookie: `${cookieFrom(later)}x` }), d);
    expect(claimsOf(forged)!.sid).not.toBe(claimsOf(later)!.sid);
  });

  // Fails if the same-origin precondition is skipped or a refused request creates a session.
  it("refuses cross-origin requests with 403 and creates nothing", async () => {
    const { d } = setup();
    for (const o of [
      { fetchSite: "cross-site", origin: "https://evil.example" },
      { fetchSite: null, origin: "https://evil.example" },
      { fetchSite: null, origin: null },
    ]) {
      const res = await handleSession(sessionReq(o), d);
      expect(res.status).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(storeDump(d.backing)).not.toContain("inference:session:");
    expect((await handleSession(sessionReq({ fetchSite: null, origin: PUBLIC_ORIGIN }), d)).status).toBe(200);
  });
});

describe("POST /api/inference/session/judge", () => {
  // Fails if a wrong code upgrades the session, or the refusal carries any detail beyond the fixed text.
  it("refuses a wrong code with 403 and keeps the session public", async () => {
    const { d } = setup();
    const s = await handleSession(sessionReq(), d);
    for (const code of ["wrong", CODE.slice(0, -1), `${CODE}x`, ""]) {
      const res = await handleJudgeUpgrade(judgeReq({ code }, { cookie: cookieFrom(s) }), d);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "invalid_code", message: "That judge code is not valid." });
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect((await readSession(sessionReq({ cookie: cookieFrom(s) }), d))?.claims.pool).toBe("public");
  });

  // Fails if the right code does not set pool judge, mints a new sid, or the stored record keeps pool public.
  it("upgrades to pool judge with the same sid on the right code", async () => {
    const { d, claimsOf } = setup();
    const s = await handleSession(sessionReq(), d);
    const sid = claimsOf(s)!.sid;
    const res = await handleJudgeUpgrade(judgeReq({ code: CODE }, { cookie: cookieFrom(s) }), d);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pool: string }).pool).toBe("judge");
    const c = claimsOf(res)!;
    expect(c.sid).toBe(sid);
    expect(c.pool).toBe("judge");
    expect(((await d.store.get(sessionKey(sid))) as { pool: string }).pool).toBe("judge");
    // The old public cookie now reads as judge too: the stored record is authoritative.
    expect((await readSession(sessionReq({ cookie: cookieFrom(s) }), d))?.claims.pool).toBe("judge");
  });

  // Fails if the cap on new judge sessions per network and day is not applied (the shared code would multiply the daily
  // call limit), a live judge session counts again, or the refusal sends a judge to a paid key or names no retry time.
  it("applies the judge sessions per client per day cap to new judge sessions only", async () => {
    const { d, clock } = setup({ JUDGE_SESSIONS_PER_CLIENT_DAY: "2" });
    const a = await handleJudgeUpgrade(judgeReq({ code: CODE }), d);
    const b = await handleSession(sessionReq(), d);
    const results = [a, await handleJudgeUpgrade(judgeReq({ code: CODE }, { cookie: cookieFrom(b) }), d)];
    for (let i = 0; i < 3; i++) results.push(await handleJudgeUpgrade(judgeReq({ code: CODE }, { cookie: cookieFrom(a) }), d));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const refused = await handleJudgeUpgrade(judgeReq({ code: CODE }), d);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("set-cookie")).toBeNull();
    const body = (await refused.json()) as { error: string; message: string; retryAt: string };
    expect([body.error, body.retryAt]).toEqual(["judge_limit", "2026-11-16T00:00:00.000Z"]);
    expect(body.message).toContain("00:00 UTC on 16 November 2026");
    expect(body.message).not.toMatch(/key/i);
    // Another network is not affected, and the next day opens again.
    expect((await handleJudgeUpgrade(judgeReq({ code: CODE }, { ip: "198.51.100.40" }), d)).status).toBe(200);
    clock.advance(24 * 3600_000);
    expect((await handleJudgeUpgrade(judgeReq({ code: CODE }), d)).status).toBe(200);
  });

  // Fails if a valid code needs a public session first, or counts one (the public cap would refuse a judge before the code is read).
  it("creates a judge session directly, past the public session cap", async () => {
    const { d, claimsOf, clock } = setup({ FREE_SESSIONS_PER_CLIENT_HOUR: "1" });
    expect([(await handleSession(sessionReq(), d)).status, (await handleSession(sessionReq(), d)).status]).toEqual([200, 429]);
    const res = await handleJudgeUpgrade(judgeReq({ code: CODE }), d);
    expect(res.status).toBe(200);
    const claims = claimsOf(res)!;
    expect(claims.pool).toBe("judge");
    expect(await res.json()).toEqual({ pool: "judge", expiresAt: new Date(clock.now() + JUDGE_SESSION_TTL_S * 1000).toISOString() });
    expect(res.headers.get("set-cookie")!.split("; ").slice(1).sort()).toEqual(["HttpOnly", `Max-Age=${JUDGE_SESSION_TTL_S}`, "Path=/api/inference", "SameSite=Strict", "Secure"]);
    expect((await readSession(sessionReq({ cookie: cookieFrom(res) }), d))?.claims).toMatchObject({ sid: claims.sid, pool: "judge" });
    // Nor does it use the network's public count.
    const other = setup({ FREE_SESSIONS_PER_CLIENT_HOUR: "1" });
    for (let i = 0; i < 3; i++) expect((await handleJudgeUpgrade(judgeReq({ code: CODE }), other.d)).status).toBe(200);
    expect((await handleSession(sessionReq(), other.d)).status).toBe(200);
  });

  // UX-H3. Fails if judge access ends during a break of days (the next page would start a public session without notice),
  // or a renewal changes the sid or the pool.
  it("keeps judge access through the judging period, over a break of weeks", async () => {
    const { d, clock, claimsOf } = setup();
    const up = await handleJudgeUpgrade(judgeReq({ code: CODE }), d);
    let cookie = cookieFrom(up);
    const { sid } = claimsOf(up)!;
    for (const days of [4, 59]) {
      clock.advance(days * 86_400_000);
      const renewed = await handleSession(sessionReq({ cookie }), d);
      expect([renewed.status, ((await renewed.json()) as { pool: string }).pool]).toEqual([200, "judge"]);
      expect(claimsOf(renewed)).toMatchObject({ sid, pool: "judge" });
      expect(claimsOf(renewed)!.exp).toBe(clock.now() + JUDGE_SESSION_TTL_S * 1000);
      cookie = cookieFrom(renewed);
    }
    // A code entered on 2026-11-25 without another visit still works when judging ends (2027-01-19T01:00Z).
    expect(Date.parse("2026-11-25T00:00:00Z") + JUDGE_SESSION_TTL_S * 1000).toBeGreaterThan(Date.parse("2027-01-19T01:00:00Z"));
    // An unused session ends.
    clock.advance(JUDGE_SESSION_TTL_S * 1000);
    expect(await readSession(sessionReq({ cookie }), d)).toBeNull();
  });

  // Fails if a leaked judge code cannot be ended: the long sessions it opened must stop when JUDGE_CODE changes or is removed.
  it("ends the judge sessions of a replaced code", async () => {
    const { d } = setup();
    const cookie = cookieFrom(await handleJudgeUpgrade(judgeReq({ code: CODE }), d));
    for (const judgeCode of ["another-code-0123456789", null]) {
      const after = { ...d, config: { ...d.config, free: { ...d.config.free, judgeCode } } };
      expect(await readSession(sessionReq({ cookie }), after)).toBeNull();
      expect(((await (await handleSession(sessionReq({ cookie }), after)).json()) as { pool: string }).pool).toBe("public");
    }
    expect((await readSession(sessionReq({ cookie }), d))?.claims.pool).toBe("judge");
  });

  // Fails if a wrong code, a malformed body or a refused origin leaves a session, a cookie or a judge count behind.
  it("creates nothing without the right code", async () => {
    const { d } = setup();
    const refusals = [judgeReq({ code: "wrong" }), judgeReq({ code: 7 }), judgeReq({ code: CODE }, { fetchSite: "cross-site", origin: "https://evil.example" })];
    const answers = await Promise.all(refusals.map((r) => handleJudgeUpgrade(r, d)));
    expect(answers.map((r) => [r.status, r.headers.get("set-cookie")])).toEqual([[403, null], [400, null], [403, null]]);
    expect(storeDump(d.backing)).not.toMatch(/inference:(session|judge-sessions):/);
  });

  // Fails if the same-origin precondition is skipped for the upgrade.
  it("refuses a cross-origin upgrade", async () => {
    const { d } = setup();
    const s = await handleSession(sessionReq(), d);
    const res = await handleJudgeUpgrade(judgeReq({ code: CODE }, { cookie: cookieFrom(s), fetchSite: "cross-site", origin: "https://evil.example" }), d);
    expect(res.status).toBe(403);
    expect((await readSession(sessionReq({ cookie: cookieFrom(s) }), d))?.claims.pool).toBe("public");
  });

  // Fails if a null JUDGE_CODE is treated as a code (for example, an empty or "null" code passing).
  it("answers 503 when judge access is not configured", async () => {
    const { d } = setup({ JUDGE_CODE: "" });
    expect(d.config.free.judgeCode).toBeNull();
    const s = await handleSession(sessionReq(), d);
    for (const code of ["", "null", CODE]) {
      const res = await handleJudgeUpgrade(judgeReq({ code }, { cookie: cookieFrom(s) }), d);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "not_configured", message: "Judge access is not configured." });
    }
  });

  // Fails if the code (or the submitted guess) reaches a response body, a header, a log line or the Store.
  it("never echoes or logs the code", async () => {
    const { d } = setup();
    const lines: string[] = [];
    captureConsole(lines);
    const guess = "guess-5d1e0b";
    const s = await handleSession(sessionReq(), d);
    const texts: string[] = [];
    for (const body of [{ code: guess }, { code: CODE }, `{"code": "${CODE}`, `{"code": ${CODE}}`, { code: 42 }]) {
      const res = await handleJudgeUpgrade(judgeReq(body, { cookie: cookieFrom(s) }), d);
      texts.push(await res.text(), JSON.stringify([...res.headers]));
    }
    // A store failure while upgrading is logged without the code.
    const failing = { ...d, store: { ...d.store, compareAndSet: () => Promise.reject(new Error(`store down`)) } };
    const s2 = await handleSession(sessionReq({ ip: "198.51.100.30" }), d);
    const down = await handleJudgeUpgrade(judgeReq({ code: CODE }, { cookie: cookieFrom(s2), ip: "198.51.100.30" }), failing);
    expect(down.status).toBe(503);
    texts.push(await down.text());
    const all = [...texts, ...lines, storeDump(d.backing)].join("\n");
    expect(all).not.toContain(CODE);
    expect(all).not.toContain(guess);
    expect(lines.length).toBeGreaterThan(0);
  });
});

// Review finding 8 (UX-H3). Fails if a judge is told to bring an AI key because the Store cannot be read, or a visitor is not.
describe("a session renewal while the Store cannot be read", () => {
  it("names no key for a judge, and the own key for a visitor", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const d = testDeps({ env: { JUDGE_CODE: "judge-code-unit" } });
    const judge = cookieFrom(await handleJudgeUpgrade(postRequest("/api/inference/session/judge", { code: "judge-code-unit" }), d));
    const visitor = cookieFrom(await handleSession(sessionReq(), d));
    const down = { ...d, store: { ...d.store, get: () => Promise.reject(new Error("down")) } };
    const text = async (cookie: string) => {
      const res = await handleSession(postRequest("/api/inference/session", undefined, { cookie }), down);
      expect(res.status).toBe(503);
      return ((await res.json()) as { message: string }).message;
    };
    expect(await text(judge)).toBe(sessionTexts.judgeUnavailable);
    expect(await text(judge)).not.toMatch(/key/i);
    expect(await text(visitor)).toBe(sessionTexts.unavailable);
    expect(unavailableText("judge")).toBe(sessionTexts.judgeUnavailable);
    expect(unavailableText("public")).toMatch(/own key/);
  });
});

describe("judge code guessing", () => {
  // Fails if judge code attempts are not limited per client (the code could be guessed without limit).
  it("refuses further codes after 10 attempts from one client in an hour, even the right one", async () => {
    const d = testDeps({ env: { JUDGE_CODE: "right-code" } });
    const origin = d.config.publicOrigin;
    const attempt = (code: string) =>
      handleJudgeUpgrade(new Request(`${origin}/api/inference/session/judge`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code }) }), d);
    for (let i = 0; i < JUDGE_ATTEMPTS_PER_CLIENT_HOUR; i++) expect((await attempt(`wrong-${i}`)).status).toBe(403);
    const blocked = await attempt("right-code");
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toBe("too_many_codes");
  });
});

describe("judge code guessing under concurrency", () => {
  // Fails if the limit is checked by a read before the increment (parallel guesses would all pass).
  it("lets at most 10 of 30 parallel attempts reach the compare", async () => {
    const d = testDeps({ env: { JUDGE_CODE: "right-code-long-enough" } });
    const origin = d.config.publicOrigin;
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        handleJudgeUpgrade(new Request(`${origin}/api/inference/session/judge`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code: `guess-${i}` }) }), d),
      ),
    );
    expect(results.filter((r) => r.status === 403)).toHaveLength(JUDGE_ATTEMPTS_PER_CLIENT_HOUR);
    expect(results.filter((r) => r.status === 429)).toHaveLength(30 - JUDGE_ATTEMPTS_PER_CLIENT_HOUR);
  });
});
