import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleChat } from "@/lib/inference/proxy";
import { REDACTED, redact, redactText } from "@/lib/inference/redact";
import { handleSession } from "@/lib/inference/session";
import { signSession } from "@/lib/inference/token";
import { PROVIDERS } from "@/lib/keys/providers";
import { fakeClock, PUBLIC_ORIGIN, testDeps } from "../helpers/server-deps";
import fixture from "../fixtures/runtime-requests/bakery-session.json";

const UPSTREAM = "https://upstream.test/v1";
const SERVER_KEY = "otk_5f1c0a9e7b3d4c2a8e6f1b0d9c7a5e3f";
const PROVIDER_BEARER = "sk-proj-Visitor0123456789abcdefABCDEF";

/** True when any 8-character window of `secret` appears in `text`. */
function leaks(text: string, secret: string): boolean {
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
  return false;
}

describe("redact", () => {
  // Fails if a credential header survives in a log object, in any letter case or inside a Headers object.
  it("removes authorization, cookie and set-cookie headers", () => {
    const headers = new Headers({ authorization: `Bearer ${SERVER_KEY}`, cookie: "retrofit_session=abc.def", "content-type": "application/json" });
    const out = redact({ headers, nested: { Authorization: "Bearer x", "Set-Cookie": "a=b", Cookie: "c=d", ok: 1 } });
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/authorization|cookie/i);
    expect(text).not.toContain(SERVER_KEY);
    expect(out).toEqual({ headers: { "content-type": "application/json" }, nested: { ok: 1 } });
  });

  // Fails if any provider key prefix in providers.ts is not redacted, at the start of a value or inside a sentence.
  it("redacts every value that starts with a provider key prefix", () => {
    for (const prefix of PROVIDERS.flatMap((p) => p.keyPrefixes)) {
      const key = `${prefix}Abc123def456ghi789`;
      expect(redactText(key)).toBe(REDACTED);
      const sentence = redactText(`upstream said: invalid key ${key}, try again`);
      expect(sentence).not.toContain("Abc123def456");
      expect(sentence).toContain("upstream said: invalid key");
      expect(redact({ v: key })).toEqual({ v: REDACTED });
    }
  });

  // Fails if a Bearer value, the placeholder, a session cookie or a session token reaches a log line.
  it("redacts Bearer values, the placeholder, session cookies and session tokens", () => {
    const token = signSession({ sid: "0123456789abcdef0123456789abcdef", iat: 1, exp: 2, client: "c", pool: "public" }, "s".repeat(32));
    const line = redactText(`auth Bearer abc.def-123 cookie retrofit_session=${token}; key retrofit-free token ${token}`);
    expect(line).not.toContain("abc.def-123");
    expect(line).not.toContain("retrofit-free");
    expect(leaks(line, token)).toBe(false);
  });

  // Fails if configured secrets (server keys without a known prefix) are not redacted.
  it("redacts exact configured secrets", () => {
    const secret = "plain-secret-value-0123456789";
    expect(redactText(`failed with ${secret}`, [secret])).toBe(`failed with ${REDACTED}`);
    expect(redact([{ e: new Error(`boom ${secret}`) }], [secret])).toEqual([{ e: `Error: boom ${REDACTED}` }]);
  });
});

describe("proxy logs", () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Fails if the proxy logs an error message, header or Bearer value without the redaction helper.
  it("no part of a key or cookie reaches the logs when the upstream fails with a message that holds them", async () => {
    const clock = fakeClock();
    const d = testDeps({ clock: clock.clock, env: { FREE_UPSTREAM_URL: UPSTREAM, OTARI_API_KEY: SERVER_KEY } });
    const session = await handleSession(new Request(`${PUBLIC_ORIGIN}/api/inference/session`, { method: "POST", headers: { "sec-fetch-site": "same-origin", "x-forwarded-for": "203.0.113.7" } }), d);
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const token = cookie.slice(cookie.indexOf("=") + 1);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        throw new Error(`connect ECONNREFUSED; sent ${headers.get("authorization")} with ${cookie} to ${String(input)}`);
      }),
    );
    const chat = (auth: string) =>
      new Request(`${PUBLIC_ORIGIN}/api/inference/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", authorization: auth, cookie },
        body: JSON.stringify(fixture.bodies[0]),
      });

    expect((await handleChat(chat("Bearer retrofit-free"), d)).status).toBe(502);
    expect((await handleChat(chat(`Bearer ${PROVIDER_BEARER}`), d)).status).toBe(401);

    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join("\n");
    expect(leaks(all, SERVER_KEY)).toBe(false);
    expect(leaks(all, PROVIDER_BEARER)).toBe(false);
    expect(leaks(all, token)).toBe(false);
    expect(all).not.toContain("retrofit-free");
  });
});
