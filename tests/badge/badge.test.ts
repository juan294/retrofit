/**
 * The badge (src/lib/badge/*; parent success criterion 6): fixed text and digits only, the headers, and
 * 404 for a host that is not public. The embed snippet escapes everything it holds.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { AccountData } from "@/lib/accounts/data";
import { AccountDataUnavailable } from "@/lib/accounts/data";
import { handleBadge } from "@/lib/badge/handler";
import { badgeSnippet } from "@/lib/badge/snippet";
import { badgeSvg } from "@/lib/badge/svg";
import type { Snapshot } from "@/lib/snapshot/types";
import { INJECTION } from "../fixtures/sites";
import { crawlFixtureSnapshots, type SiteName } from "../helpers/fixture-snapshots";
import { testDeps, type TestDeps } from "../helpers/server-deps";
import { HOST, lapseNow, publishDirect, snapshotOf, verifiedClaim } from "../publish/setup";

let snapshots: Map<SiteName, Snapshot>;
beforeAll(async () => {
  snapshots = await crawlFixtureSnapshots();
}, 60_000);

const T1 = "2026-11-20T08:00:00.000Z";
async function published(snapshot: Snapshot, score?: number | null) {
  const d = testDeps();
  const claim = await verifiedClaim(d, undefined, snapshot.host);
  await publishDirect(d, snapshot, { score });
  return { d, claim };
}
const visibleText = (svg: string) => svg.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("badge SVG", () => {
  // Fails if a score does not show, or the text is anything but the fixed words and digits.
  it.each([0, 7, 100])("shows the score %i with the fixed text only", async (score) => {
    const { d } = await published(snapshotOf(HOST, T1), score);
    const svg = await (await handleBadge(d, `${HOST}.svg`)).text();
    expect(svg).toBe(badgeSvg(score));
    expect(svg.startsWith("<svg ")).toBe(true);
    const line = `Agent-ready ${score}/100 · verified by Retrofit`;
    expect(visibleText(svg)).toBe(`${line} ${line}`);
    expect(svg).toContain(`aria-label="${line}"`);
    expect(svg).not.toMatch(/<script|<style|<image|<a[ >]|<foreignObject|href|url\(|on[a-z]+=|&/i);
  });

  // Fails if a score that is not an integer from 0 to 100 reaches the SVG.
  it.each([null, -1, 101, 7.5, NaN, Infinity, "7" as unknown as number, "<b>" as unknown as number])("a score of %s shows no number", (score) => {
    expect(badgeSvg(score)).not.toMatch(/\/100/);
    expect(badgeSvg(score)).toBe(badgeSvg(null));
    expect(visibleText(badgeSvg(null))).toBe("Agent-ready check · verified by Retrofit Agent-ready check · verified by Retrofit");
  });

  // Fails if a site's text or host reaches the badge.
  it("the hostile fixture's host and text never appear", async () => {
    const snapshot = snapshots.get("hostile")!;
    const { d } = await published(snapshot);
    const svg = await (await handleBadge(d, `${snapshot.host}.svg`)).text();
    expect(svg).toMatch(/Agent-ready \d+\/100/);
    const words = [snapshot.host, snapshot.host.split(":")[0]!, "hostile", INJECTION, "Ignore", "instructions", "candles"];
    for (const word of words) expect(svg.toLowerCase(), word).not.toContain(word.toLowerCase());
  });
});

describe("GET /badge/<host>.svg", () => {
  // Fails if the badge is not an embeddable, hour-cached image, or could run anything when opened on Retrofit's origin.
  it("answers an SVG image cached for one hour that any site may load, with a policy that allows nothing", async () => {
    const { d } = await published(snapshotOf(HOST, T1), 72);
    const res = await handleBadge(d, `${HOST}.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  // Fails if a host that is not public has a badge, or its 404 is cached.
  it("answers an uncached 404 for an unknown, unpublished, lapsed or differently written host and for another file name", async () => {
    const { d, claim } = await published(snapshotOf(HOST, T1), 72);
    await verifiedClaim(d, undefined, "claimed.example.com");
    const names = ["unknown.example.com.svg", "claimed.example.com.svg", "SHOP.example.com.svg", `${HOST}..svg`, `${HOST}:443.svg`, HOST, `${HOST}.png`, `${HOST}.SVG`, ".svg", "", `${HOST}.svg.svg`, "..%2f.svg"];
    const expect404 = async (name: string) => {
      const res = await handleBadge(d, name);
      expect(res.status, name).toBe(404);
      expect(res.headers.get("cache-control"), name).toBe("no-store");
      expect(res.headers.get("content-type"), name).toBe("application/json");
    };
    for (const name of names) await expect404(name);
    await lapseNow(d, claim);
    await expect404(`${HOST}.svg`);
  });

  // Fails if an outage is cached or looks like an unknown host, or the badge loads the snapshot or report.
  it("uses the light read; an outage answers an uncached 503", async () => {
    const { d } = await published(snapshotOf(HOST, T1), 72);
    const fail = async () => { throw new AccountDataUnavailable("x", "request_failed"); };
    const down = (o: Partial<AccountData>): TestDeps => ({ ...d, accounts: { ...d.accounts, ...o } });
    expect((await handleBadge(down({ getPublicSnapshot: fail, getPublicReport: fail }), `${HOST}.svg`)).status).toBe(200);
    const res = await handleBadge(down({ getPublicSite: fail }), `${HOST}.svg`);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("badge embed snippet", () => {
  // Fails if the snippet is not the plan's, or a character that could leave its attribute is not escaped.
  it("links the badge to the published page and escapes its values", () => {
    expect(badgeSnippet("https://retrofit.thecreativetoken.com", HOST)).toBe(
      `<a href="https://retrofit.thecreativetoken.com/s/${HOST}"><img src="https://retrofit.thecreativetoken.com/badge/${HOST}.svg" alt="Agent-ready score by Retrofit"></a>`,
    );
    const hostile = badgeSnippet("https://retrofit.test", `x"><script>'&`);
    expect(hostile).toContain(`/s/x&quot;&gt;&lt;script&gt;&#39;&amp;"`);
    expect(hostile).not.toMatch(/<script|"><s/);
  });
});
