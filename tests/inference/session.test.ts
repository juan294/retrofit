import { afterEach, describe, expect, it, vi } from "vitest";
import { handleJudgeUpgrade, handleSession, readSession, sessionKey } from "@/lib/inference/session";
import { verifySession } from "@/lib/inference/token";
import { fakeClock, PUBLIC_ORIGIN, storeDump, testDeps } from "../helpers/server-deps";

const CODE = "judge-code-7f3a91c2";

interface Opts {
  cookie?: string;
  ip?: string;
  origin?: string | null;
  fetchSite?: string | null;
}

function post(path: string, body: unknown, o: Opts = {}): Request {
  const headers = new Headers({ "content-type": "application/json", "x-forwarded-for": o.ip ?? "203.0.113.7" });
  if (o.fetchSite !== null) headers.set("sec-fetch-site", o.fetchSite ?? "same-origin");
  if (o.origin) headers.set("origin", o.origin);
  if (o.cookie) headers.set("cookie", o.cookie);
  return new Request(`${PUBLIC_ORIGIN}${path}`, { method: "POST", headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
}
const sessionReq = (o: Opts = {}) => post("/api/inference/session", undefined, o);
const judgeReq = (body: unknown, o: Opts = {}) => post("/api/inference/session/judge", body, o);

function cookieOf(res: Response): string {
  const raw = res.headers.get("set-cookie");
  if (!raw) throw new Error("no Set-Cookie");
  return raw.split(";")[0] as string;
}
const tokenOf = (res: Response) => cookieOf(res).replace(/^retrofit_session=/, "");

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

  // Fails if renewal mints a new sid, resets the pool, or does not extend the expiry and the stored record's TTL.
  it("renews a valid cookie with the same sid and pool", async () => {
    const { d, clock, claimsOf } = setup();
    const first = await handleSession(sessionReq(), d);
    const c1 = claimsOf(first)!;
    const up = await handleJudgeUpgrade(judgeReq({ code: CODE }, { cookie: cookieOf(first) }), d);
    expect(up.status).toBe(200);
    // A counter another module keeps under the sid survives renewal.
    await d.store.incrementWindow(`inference:test-counter:${c1.sid}`, 86_400, 5);

    clock.advance(90 * 60_000);
    const renewed = await handleSession(sessionReq({ cookie: cookieOf(up) }), d);
    expect(renewed.status).toBe(200);
    const c2 = claimsOf(renewed)!;
    expect(c2.sid).toBe(c1.sid);
    expect(c2.pool).toBe("judge");
    expect(c2.client).toBe(c1.client);
    expect(c2.exp).toBe(clock.now() + 7200_000);
    expect(((await renewed.json()) as { pool: string }).pool).toBe("judge");
    expect(await d.store.incrementWindow(`inference:test-counter:${c1.sid}`, 86_400, 0)).toBe(5);

    // The stored record was renewed: it outlives the original two hours.
    clock.advance(60 * 60_000);
    expect(await readSession(sessionReq({ cookie: cookieOf(renewed) }), d)).toEqual({ claims: expect.objectContaining({ sid: c1.sid, pool: "judge" }) });
  });

  // Fails if renewals count against the per-client cap, or new sessions are not capped.
  it("applies the per-client cap only to new sessions", async () => {
    const { d } = setup({ FREE_SESSIONS_PER_CLIENT_HOUR: "2" });
    const a = await handleSession(sessionReq(), d);
    const b = await handleSession(sessionReq(), d);
    expect([a.status, b.status]).toEqual([200, 200]);
    for (let i = 0; i < 5; i++) expect((await handleSession(sessionReq({ cookie: cookieOf(a) }), d)).status).toBe(200);
    const third = await handleSession(sessionReq(), d);
    expect(third.status).toBe(429);
    const body = (await third.json()) as { error: string; message: string; retryAt: string };
    expect(body.error).toBe("session_limit");
    expect(body.message).toContain("Paste your own key in AI settings to continue.");
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
    const later = await handleSession(sessionReq({ cookie: cookieOf(first) }), d);
    expect(later.status).toBe(200);
    expect(claimsOf(later)!.sid).not.toBe(sid);
    const forged = await handleSession(sessionReq({ cookie: `${cookieOf(later)}x` }), d);
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
      const res = await handleJudgeUpgrade(judgeReq({ code }, { cookie: cookieOf(s) }), d);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "invalid_code", message: "That judge code is not valid." });
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect((await readSession(sessionReq({ cookie: cookieOf(s) }), d))?.claims.pool).toBe("public");
  });

  // Fails if the right code does not set pool judge, mints a new sid, or the stored record keeps pool public.
  it("upgrades to pool judge with the same sid on the right code", async () => {
    const { d, claimsOf } = setup();
    const s = await handleSession(sessionReq(), d);
    const sid = claimsOf(s)!.sid;
    const res = await handleJudgeUpgrade(judgeReq({ code: CODE }, { cookie: cookieOf(s) }), d);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pool: string }).pool).toBe("judge");
    const c = claimsOf(res)!;
    expect(c.sid).toBe(sid);
    expect(c.pool).toBe("judge");
    expect(((await d.store.get(sessionKey(sid))) as { pool: string }).pool).toBe("judge");
    // The old public cookie now reads as judge too: the stored record is authoritative.
    expect((await readSession(sessionReq({ cookie: cookieOf(s) }), d))?.claims.pool).toBe("judge");
  });

  // Fails if the judge cap is not applied per client per day, or a repeat on a judge session counts again.
  it("applies the judge sessions per client per day cap", async () => {
    const { d, clock } = setup({ JUDGE_SESSIONS_PER_CLIENT_DAY: "1" });
    const a = await handleSession(sessionReq(), d);
    expect((await handleJudgeUpgrade(judgeReq({ code: CODE }, { cookie: cookieOf(a) }), d)).status).toBe(200);
    expect((await handleJudgeUpgrade(judgeReq({ code: CODE }, { cookie: cookieOf(a) }), d)).status).toBe(200);
    const b = await handleSession(sessionReq(), d);
    const refused = await handleJudgeUpgrade(judgeReq({ code: CODE }, { cookie: cookieOf(b) }), d);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toBe("judge_limit");
    clock.advance(24 * 3600_000);
    const c = await handleSession(sessionReq(), d);
    expect((await handleJudgeUpgrade(judgeReq({ code: CODE }, { cookie: cookieOf(c) }), d)).status).toBe(200);
  });

  // Fails if the upgrade works without a valid session cookie.
  it("requires a valid session cookie", async () => {
    const { d } = setup();
    const res = await handleJudgeUpgrade(judgeReq({ code: CODE }), d);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  // Fails if the same-origin precondition is skipped for the upgrade.
  it("refuses a cross-origin upgrade", async () => {
    const { d } = setup();
    const s = await handleSession(sessionReq(), d);
    const res = await handleJudgeUpgrade(judgeReq({ code: CODE }, { cookie: cookieOf(s), fetchSite: "cross-site", origin: "https://evil.example" }), d);
    expect(res.status).toBe(403);
    expect((await readSession(sessionReq({ cookie: cookieOf(s) }), d))?.claims.pool).toBe("public");
  });

  // Fails if a null JUDGE_CODE is treated as a code (for example, an empty or "null" code passing).
  it("answers 503 when judge access is not configured", async () => {
    const { d } = setup({ JUDGE_CODE: "" });
    expect(d.config.free.judgeCode).toBeNull();
    const s = await handleSession(sessionReq(), d);
    for (const code of ["", "null", CODE]) {
      const res = await handleJudgeUpgrade(judgeReq({ code }, { cookie: cookieOf(s) }), d);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "not_configured", message: "Judge access is not configured." });
    }
  });

  // Fails if the code (or the submitted guess) reaches a response body, a header, a log line or the Store.
  it("never echoes or logs the code", async () => {
    const { d } = setup();
    const lines: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    }
    const guess = "guess-5d1e0b";
    const s = await handleSession(sessionReq(), d);
    const texts: string[] = [];
    for (const body of [{ code: guess }, { code: CODE }, `{"code": "${CODE}`, `{"code": ${CODE}}`, { code: 42 }]) {
      const res = await handleJudgeUpgrade(judgeReq(body, { cookie: cookieOf(s) }), d);
      texts.push(await res.text(), JSON.stringify([...res.headers]));
    }
    // A store failure while upgrading is logged without the code.
    const failing = { ...d, store: { ...d.store, compareAndSet: () => Promise.reject(new Error(`store down`)) } };
    const s2 = await handleSession(sessionReq({ ip: "198.51.100.30" }), d);
    const down = await handleJudgeUpgrade(judgeReq({ code: CODE }, { cookie: cookieOf(s2), ip: "198.51.100.30" }), failing);
    expect(down.status).toBe(503);
    texts.push(await down.text());
    const all = [...texts, ...lines, storeDump(d.backing)].join("\n");
    expect(all).not.toContain(CODE);
    expect(all).not.toContain(guess);
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("judge code guessing", () => {
  // Fails if wrong judge codes are not limited per client (the code could be guessed without limit).
  it("refuses further codes after 10 wrong ones from one client in an hour, even the right one", async () => {
    const { JUDGE_FAILURES_PER_CLIENT_HOUR, handleJudgeUpgrade, handleSession } = await import("@/lib/inference/session");
    const { testDeps } = await import("../helpers/server-deps");
    const d = testDeps({ env: { JUDGE_CODE: "right-code" } });
    const origin = d.config.publicOrigin;
    const created = await handleSession(new Request(`${origin}/api/inference/session`, { method: "POST", headers: { origin } }), d);
    const cookie = (created.headers.get("set-cookie") ?? "").split(";")[0]!;
    const attempt = (code: string) =>
      handleJudgeUpgrade(new Request(`${origin}/api/inference/session/judge`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ code }) }), d);
    for (let i = 0; i < JUDGE_FAILURES_PER_CLIENT_HOUR; i++) expect((await attempt(`wrong-${i}`)).status).toBe(403);
    const blocked = await attempt("right-code");
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toBe("too_many_codes");
  });
});
