/**
 * The meta and DNS checks of an ownership claim (src/lib/claims/verify.ts). Fixture sites on a
 * loopback server stand in for the home page; a fake TXT resolver stands in for DNS. No test
 * reaches the network or real DNS (noRealDns for names, a fake for TXT).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Claim } from "@/lib/accounts/data";
import { claimRecordName } from "@/lib/claims/host";
import { checkClaim, runClaimCheck } from "@/lib/claims/verify";
import type { TxtResolver } from "@/lib/claims/txt";
import { sha256Hex } from "@/lib/security/tokens";
import { blocked, hostile, materialize, type FixtureSite } from "../fixtures/sites";
import { startFixtureServer, type FixtureRoutes, type FixtureServer } from "../helpers/fixture-server";
import { noRealDns, testDeps, TEST_ACCOUNT, type TestDepsOptions } from "../helpers/server-deps";

const TOKEN = "0123456789abcdef0123456789abcdef";
const page = (head: string, body = "<p>Home</p>") => ({ headers: { "content-type": "text/html; charset=utf-8" }, body: `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>` });
const allow = { headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" };
const tag = (value: string, name = "retrofit-site-verification") => `<meta name="${name}" content="${value}">`;

let server: FixtureServer | undefined;
let currentRoutes: FixtureRoutes | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Serves `sites` (host label -> site) and returns the claim host of each (`<label>.fixture.test:<port>`). */
async function serve(sites: Record<string, FixtureSite>): Promise<(label: string) => string> {
  const routes: FixtureRoutes = {};
  currentRoutes = routes;
  server = await startFixtureServer(routes);
  const s = server;
  for (const [label, site] of Object.entries(sites)) {
    const host = `${label}.fixture.test`;
    routes[host] = materialize(site, s.url(host, "").replace(/\/$/, "")) as FixtureRoutes[string];
  }
  return (label) => `${label}.fixture.test:${s.port}`;
}

const deps = (o: TestDepsOptions = {}) => testDeps({ lookup: noRealDns, ...o });

function claim(host: string, method: "meta" | "dns" = "meta", token = TOKEN): Claim {
  return {
    id: "00000000-0000-4000-8000-0000000000c1",
    accountId: TEST_ACCOUNT.userId,
    host,
    method,
    tokenHash: sha256Hex(token),
    status: "pending",
    createdAt: "2026-11-23T10:00:00.000Z",
    verifiedAt: null,
    lastCheckedAt: null,
    failures: 0,
    supersededAt: null,
    lastResult: null,
    lastDetail: null,
  };
}

describe("meta method", () => {
  // Fails if the tag in the home page head with the claim's token does not verify.
  it("verifies a retrofit-site-verification meta tag in the <head> with the claim's token", async () => {
    const host = await serve({ ok: { "/robots.txt": allow, "/": page(tag(TOKEN)) } });
    expect(await checkClaim(deps(), claim(host("ok")))).toEqual({ passed: true });
  });

  // Fails if the name is matched case-sensitively (HTML attribute values for name are matched here without case).
  it("matches the name without case, as HTML authors may write it", async () => {
    const host = await serve({ upper: { "/robots.txt": allow, "/": page(tag(TOKEN, "Retrofit-Site-Verification")) } });
    expect(await checkClaim(deps(), claim(host("upper")))).toEqual({ passed: true });
  });

  // Fails if a tag in the body counts: only the head is read.
  it("ignores the tag in the <body>", async () => {
    const host = await serve({ body: { "/robots.txt": allow, "/": page("<title>t</title>", `<p>Home</p>${tag(TOKEN)}`) } });
    expect(await checkClaim(deps(), claim(host("body")))).toEqual({ passed: false, result: "tag_missing", detail: null });
  });

  // Fails if a commented-out tag or a tag with another name counts.
  it("ignores a tag in a comment and a tag with another name", async () => {
    const host = await serve({
      comment: { "/robots.txt": allow, "/": page(`<!-- ${tag(TOKEN)} -->`) },
      other: { "/robots.txt": allow, "/": page(`${tag(TOKEN, "google-site-verification")}${tag(TOKEN, "retrofit-site-verification-old")}<meta property="retrofit-site-verification" content="${TOKEN}">`) },
    });
    expect(await checkClaim(deps(), claim(host("comment")))).toEqual({ passed: false, result: "tag_missing", detail: null });
    expect(await checkClaim(deps(), claim(host("other")))).toEqual({ passed: false, result: "tag_missing", detail: null });
  });

  // Fails if a wrong token verifies, or the number of tags found is not reported.
  it("refuses a wrong token and reports how many tags it found", async () => {
    const host = await serve({ wrong: { "/robots.txt": allow, "/": page(`${tag("f".repeat(32))}${tag(` ${TOKEN}x`)}`) } });
    expect(await checkClaim(deps(), claim(host("wrong")))).toEqual({ passed: false, result: "tag_mismatch", detail: 2 });
  });

  // Fails if one matching tag among several does not verify.
  it("verifies when one of several tags carries the token", async () => {
    const host = await serve({ several: { "/robots.txt": allow, "/": page(`${tag("old-token")}${tag(TOKEN)}`) } });
    expect(await checkClaim(deps(), claim(host("several")))).toEqual({ passed: true });
  });

  // Fails if a robots-blocked home page is fetched anyway, or the owner is not told to use DNS.
  it("a site whose robots.txt blocks RetrofitBot gives robots_blocked and is never read", async () => {
    const host = await serve({ blocked: { ...blocked, "/": page(tag(TOKEN)) } });
    expect(await checkClaim(deps(), claim(host("blocked")))).toEqual({ passed: false, result: "robots_blocked", detail: null });
    expect(server?.requests.map((r) => r.path)).toEqual(["/robots.txt"]);
  });

  // Fails if a timeout verifies, throws, or is recorded as anything but a pending claim with a timeout.
  it("a fetch timeout stays pending with the timeout result", async () => {
    const host = await serve({ slow: { "/robots.txt": allow, "/": page(tag(TOKEN)) } });
    holdHome("slow.fixture.test");
    const d = deps({ env: { FETCH_TIMEOUT_MS: "200" } });
    const created = await d.accounts.createClaim(TEST_ACCOUNT.userId, { host: host("slow"), method: "meta", tokenHash: sha256Hex(TOKEN) });
    if (created.outcome !== "created") throw new Error("create failed");
    const { claim: after } = await runClaimCheck(d, created.claim);
    expect(after).toMatchObject({ status: "pending", lastResult: "timeout", failures: 1, verifiedAt: null });
  });

  // Fails if a tag on another host that the home page redirects to counts for this host.
  it("does not follow the home page to another host: redirected", async () => {
    const host = await serve({ moved: { "/robots.txt": allow }, target: { "/robots.txt": allow, "/": page(tag(TOKEN)) } });
    routesOf()["moved.fixture.test"]!["/"] = { status: 301, headers: { location: `http://${host("target")}/` } };
    expect(await checkClaim(deps(), claim(host("moved")))).toEqual({ passed: false, result: "redirected", detail: null });
  });

  // Fails if an error status or a non-HTML answer verifies, or the status is not reported.
  it("reports an error status and a non-HTML home page", async () => {
    const host = await serve({
      gone: { "/robots.txt": allow, "/": { status: 404, headers: { "content-type": "text/html" }, body: `<head>${tag(TOKEN)}</head>` } },
      image: { "/robots.txt": allow, "/": { headers: { "content-type": "image/png" }, body: "png" } },
    });
    expect(await checkClaim(deps(), claim(host("gone")))).toEqual({ passed: false, result: "http_status", detail: 404 });
    expect(await checkClaim(deps(), claim(host("image")))).toEqual({ passed: false, result: "not_html", detail: null });
  });

  // Fails if a host that is not a public website (outside fixtures, an address in a private range) is fetched.
  it("a host that resolves to a private address gives not_public", async () => {
    const d = testDeps({ lookup: async () => [{ address: "10.0.0.5", family: 4 }], env: { RETROFIT_TEST_FIXTURES: "" } });
    expect(await checkClaim(d, claim("intranet.example.com"))).toEqual({ passed: false, result: "not_public", detail: null });
  });

  // Fails if the hostile fixture's home page (prompt injection, huge text) changes the outcome beyond tag_missing.
  it("reads a hostile home page as data: tag_missing", async () => {
    const host = await serve({ hostile });
    expect(await checkClaim(deps(), claim(host("hostile")))).toEqual({ passed: false, result: "tag_missing", detail: null });
  });
});

describe("dns method", () => {
  const txt = (records: Record<string, string[][]>, calls: string[] = []): TxtResolver => async (name) => {
    calls.push(name);
    const found = records[name];
    if (!found) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: "ENOTFOUND" });
    return found;
  };

  // Fails if the record name is not _retrofit-verification.<host name> (without the port), or split strings are not joined.
  it("joins the strings of each TXT record and accepts the one equal to retrofit-site-verification=<token>", async () => {
    const calls: string[] = [];
    const d = deps({ txt: txt({ "_retrofit-verification.shop.example.com": [["v=spf1 -all"], ["retrofit-site-verification=", TOKEN.slice(0, 10), TOKEN.slice(10)], ["other=1"]] }, calls) });
    expect(await checkClaim(d, claim("shop.example.com", "dns"))).toEqual({ passed: true });
    expect(calls).toEqual(["_retrofit-verification.shop.example.com"]);
    expect(claimRecordName("bakery.fixture.test:3011")).toBe("_retrofit-verification.bakery.fixture.test");
  });

  // Fails if a wrong token, a prefix match or a value with extra text verifies, or the record count is not reported.
  it("refuses a wrong token or a value with extra text, and reports how many records it found", async () => {
    const d = deps({ txt: txt({ "_retrofit-verification.shop.example.com": [["retrofit-site-verification=", "f".repeat(32)], [`retrofit-site-verification=${TOKEN} `], [`retrofit-site-verification=${TOKEN}x`]] }) });
    expect(await checkClaim(d, claim("shop.example.com", "dns"))).toEqual({ passed: false, result: "record_mismatch", detail: 3 });
  });

  // Fails if a missing record (NXDOMAIN or no TXT data) is not reported as record_missing.
  it("NXDOMAIN and ENODATA give record_missing; any other DNS error gives dns_failed", async () => {
    expect(await checkClaim(deps({ txt: txt({}) }), claim("shop.example.com", "dns"))).toEqual({ passed: false, result: "record_missing", detail: null });
    const noData: TxtResolver = async () => {
      throw Object.assign(new Error("queryTxt ENODATA"), { code: "ENODATA" });
    };
    expect(await checkClaim(deps({ txt: noData }), claim("shop.example.com", "dns"))).toEqual({ passed: false, result: "record_missing", detail: null });
    const empty: TxtResolver = async () => [];
    expect(await checkClaim(deps({ txt: empty }), claim("shop.example.com", "dns"))).toEqual({ passed: false, result: "record_missing", detail: null });
    const servfail: TxtResolver = async () => {
      throw Object.assign(new Error("queryTxt ESERVFAIL"), { code: "ESERVFAIL" });
    };
    expect(await checkClaim(deps({ txt: servfail }), claim("shop.example.com", "dns"))).toEqual({ passed: false, result: "dns_failed", detail: null });
  });

  // Fails if an IDN host is looked up in Unicode instead of punycode.
  it("looks up an IDN host in punycode", async () => {
    const calls: string[] = [];
    await checkClaim(deps({ txt: txt({}, calls) }), claim("xn--bcher-kva.example", "dns"));
    expect(calls).toEqual(["_retrofit-verification.xn--bcher-kva.example"]);
  });
});

describe("recording a check", () => {
  // Fails if a passing DNS check is not recorded as verified, or a failing one changes the status of a pending claim.
  it("runClaimCheck records a pass as verified and a failure with its result, never verifying on failure", async () => {
    let records: string[][] = [];
    const d = deps({ txt: async () => records });
    const created = await d.accounts.createClaim(TEST_ACCOUNT.userId, { host: "shop.example.com", method: "dns", tokenHash: sha256Hex(TOKEN) });
    if (created.outcome !== "created") throw new Error("create failed");
    const { claim: failed } = await runClaimCheck(d, created.claim);
    expect(failed).toMatchObject({ status: "pending", lastResult: "record_missing", failures: 1 });
    records = [[`retrofit-site-verification=${TOKEN}`]];
    const { claim: passed, checked } = await runClaimCheck(d, failed);
    expect(checked).toBe(true);
    expect(passed).toMatchObject({ status: "verified", lastResult: "verified", failures: 0 });
    expect(passed.verifiedAt).toBe(passed.lastCheckedAt);
  });
});

/** Makes the home page of `host` never answer (until the server closes). */
function holdHome(host: string) {
  routesOf()[host]!["/"] = () => new Promise<void>(() => {});
}

/** The routes of the running fixture server, which a test may change. */
function routesOf(): FixtureRoutes {
  if (!currentRoutes) throw new Error("no routes");
  return currentRoutes;
}
