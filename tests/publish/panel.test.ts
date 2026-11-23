/**
 * The publish controls in a claim panel on /account, and the BYOK agent panel of /s/<host>, as the
 * server renders them before hydration.
 */
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Claim, PublishedSite } from "@/lib/accounts/data";
import { accountClaimViews } from "@/lib/claims/view";
import { loadConfig } from "@/lib/config";
import { CLAIMS_TEXT } from "@/lib/site/claims-texts";
import { PUBLISH_TEXT } from "@/lib/site/publish-texts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
const { ClaimsSection } = await import("@/components/claims/ClaimsSection");
const { PublishedAgent } = await import("@/components/publish/PublishedAgent");

const config = loadConfig({ SESSION_SECRET: "s".repeat(32), PUBLIC_ORIGIN: "https://retrofit.test" });
const HOST = "shop.example.com";
const claim: Claim = {
  id: "00000000-0000-4000-8000-0000000000c1",
  accountId: "4f1c2b8e-1d2a-4e55-9c3b-2a1b0c9d8e7f",
  host: HOST,
  method: "meta",
  tokenHash: "a".repeat(64),
  status: "verified",
  createdAt: "2026-11-20T10:00:00.000Z",
  verifiedAt: "2026-11-20T10:05:00.000Z",
  lastCheckedAt: "2026-11-20T10:05:00.000Z",
  failures: 0,
  supersededAt: null,
  lapsedAt: null,
  lastResult: "verified",
  lastDetail: null,
};
const site: PublishedSite = { host: HOST, claimId: claim.id, score: 72, fetchedAt: "2026-11-20T08:00:00.000Z", publishedAt: "2026-11-20T10:10:00.000Z", refreshedAt: "2026-11-20T10:10:00.000Z", lastRefreshError: null };
const render = (c: Partial<Claim>, s: Partial<PublishedSite> | null) =>
  renderToStaticMarkup(createElement(ClaimsSection, { claims: accountClaimViews([{ ...claim, ...c }], s ? [{ ...site, ...s }] : [], config), options: [] }));

describe("publish controls", () => {
  // Fails if a control is not a POST form to its route, or can act before hydration.
  it("every form is a POST form and every button starts disabled", () => {
    const html = render({}, {});
    const forms = html.match(/<form[^>]*>/g) ?? [];
    for (const f of forms) {
      expect(f).toMatch(/method="post"/);
      expect(f).toMatch(/action="\/api\/(claims|publish)(\/check|\/start-over|\/remove)?"/);
    }
    expect(forms.filter((f) => f.includes('action="/api/publish"'))).toHaveLength(1);
    expect(forms.filter((f) => f.includes('action="/api/publish/remove"'))).toHaveLength(1);
    for (const b of html.match(/<button[^>]*>/g) ?? []) expect(b).toMatch(/disabled=""/);
  });

  // Fails if an unverified claim offers Publish, or a verified one does not.
  it("offers Publish for a verified claim only", () => {
    expect(render({}, null)).toContain(`>${PUBLISH_TEXT.publish}<`);
    for (const status of ["pending", "superseded"] as const) expect(render({ status, supersededAt: "2026-11-21T08:00:00.000Z" }, null)).not.toContain(`>${PUBLISH_TEXT.publish}<`);
    expect(render({ status: "lapsed", lapsedAt: "2026-11-21T08:00:00.000Z" }, null)).not.toContain(`>${PUBLISH_TEXT.publish}<`);
  });

  // Fails if a published site does not show its link, saved date, Refresh, Unpublish or the escaped badge snippet.
  it("shows the public link, the saved date, Refresh, Unpublish and the badge snippet", () => {
    const html = render({}, {});
    expect(html).toContain(`href="https://retrofit.test/s/${HOST}"`);
    expect(html).toContain("20 November 2026");
    expect(html).toContain(`>${PUBLISH_TEXT.refresh}<`);
    expect(html).toContain(`>${PUBLISH_TEXT.unpublish}<`);
    expect(html).toContain(`&lt;a href=&quot;https://retrofit.test/s/${HOST}&quot;&gt;&lt;img src=&quot;https://retrofit.test/badge/${HOST}.svg&quot; alt=&quot;Agent-ready score by Retrofit&quot;&gt;&lt;/a&gt;`);
    expect(html).not.toContain(`>${PUBLISH_TEXT.publish}<`);
  });

  // The stuck state "Published refresh failed": the error and Try again; the saved date stays.
  it("shows the last refresh error with Try again", () => {
    const html = render({}, { lastRefreshError: "generation_failed" });
    expect(html).toContain(PUBLISH_TEXT.refreshError.generation_failed(HOST));
    expect(html).toContain(`>${PUBLISH_TEXT.tryAgain}<`);
    expect(html).not.toContain(`>${PUBLISH_TEXT.refresh}<`);
    expect(html).toContain("20 November 2026");
  });

  // The stuck state "Claim lapsed": paused, with no link that answers 404 and no Refresh.
  it("a lapsed or pending claim shows the paused state with Unpublish only", () => {
    for (const c of [{ status: "lapsed", lapsedAt: "2026-11-21T08:00:00.000Z" }, { status: "pending", verifiedAt: null }] as const) {
      const html = render(c, {});
      expect(html).toContain(PUBLISH_TEXT.paused);
      expect(html).toContain(`>${PUBLISH_TEXT.unpublish}<`);
      for (const t of [PUBLISH_TEXT.refresh, PUBLISH_TEXT.publish, PUBLISH_TEXT.tryAgain]) expect(html).not.toContain(`>${t}<`);
      expect(html).not.toContain(`href="https://retrofit.test/s/${HOST}"`);
    }
    expect(render({ status: "lapsed", lapsedAt: "2026-11-21T08:00:00.000Z" }, {})).toContain(CLAIMS_TEXT.status.lapsed("2026-11-21T08:00:00.000Z"));
  });
});

describe("the published agent panel", () => {
  // Fails if the published page can start Retrofit's free AI or calls the agent unofficial.
  it("renders the own-key notice with no free AI, no unofficial label and no inference route", () => {
    const html = renderToStaticMarkup(createElement(PublishedAgent, { host: HOST }));
    expect(html).toContain(HOST);
    // P4-R6. True to the code: the browser sends the key to the chosen provider only.
    expect(html).toContain("Your key goes only to that provider, never to Retrofit.");
    expect(html).not.toMatch(/free AI|unofficial|\/api\/inference/i);
  });

  // Fails if the panel's own modules import the free session, whose code names /api/inference.
  it("imports nothing that calls /api/inference", async () => {
    const seen = new Set<string>();
    const queue = ["src/components/publish/PublishedAgent.tsx"];
    for (let f = queue.shift(); f; f = queue.shift()) {
      if (seen.has(f)) continue;
      seen.add(f);
      const source = await readFile(f, "utf8");
      expect(source, f).not.toContain("/api/inference");
      for (const m of source.matchAll(/from "([^"]+)"/g)) {
        const spec = m[1]!;
        const base = spec.startsWith("@/") ? `src/${spec.slice(2)}` : spec.startsWith(".") ? new URL(spec, `file:///${f}`).pathname.slice(1) : null;
        if (!base) continue;
        for (const ext of [".ts", ".tsx"]) if (await readFile(base + ext).then(() => true, () => false)) queue.push(base + ext);
      }
    }
    expect([...seen]).toContain("src/components/preview/Preview.tsx");
    expect([...seen].some((f) => f.includes("useFreeSession"))).toBe(false);
  });
});
