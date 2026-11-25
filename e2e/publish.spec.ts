import { execFileSync } from "node:child_process";
import http from "node:http";
import { test, expect } from "./fixtures/csp";
import { CLAIMS_TEXT } from "@/lib/site/claims-texts";
import { PUBLISHED_PAGE_TEXT, PUBLISH_TEXT } from "@/lib/site/publish-texts";
import { networkNameFor } from "@/lib/generate/network";
import { analyzeFixture, mockOtari, OTARI, submitKey, traceEvents } from "./support/agent";
import { addClaimTag, checkAgain, claimHostOf, claimPanel, CLAIM_HOST, FLAKY_HOST, lapseFlaky, setClockOffset, shownToken, panelButton } from "./support/claims";
import { expectInert, hostileScript, IMG, injectHostileContent, JS_LINK, SCRIPT } from "./support/extra-hostile";
import { recordRequests, RETROFIT_ORIGIN } from "./support/extra-requests";
import { fixtureOrigin } from "./support/global-setup";
import { badgeUrl, failRefresh, pageUrl, publishedByDns, publishedOwner, saveTestKey, setOutage } from "./support/publish";

// Publishing and the badge (phase-4.md; parent success criteria 5 and 6).

const networkUrl = (host: string) => `${pageUrl(host)}/${networkNameFor(claimHostOf(host))}`;

test.describe("published sites", () => {
  test.afterEach(async ({ page, request }) => {
    await setClockOffset(request, 0);
    await setOutage(page, false);
  });

  // Fails if a visitor without cookies cannot read the report or use the agent with their own key, the page uses Retrofit's free AI or
  // calls itself unofficial, the key or a question reaches Retrofit, or another site's runtime would refuse the published network.
  test("an owner publishes; a visitor without cookies reads the report and asks the agent with their own key; check_partner accepts it", async ({ page, browser }) => {
    test.setTimeout(90_000);
    await publishedOwner(page, CLAIM_HOST, "main");
    const panel = claimPanel(page, CLAIM_HOST);
    await expect(panel.getByTestId("badge-snippet")).toHaveText(`<a href="${pageUrl(CLAIM_HOST)}"><img src="${badgeUrl(CLAIM_HOST)}" alt="Agent-ready score by Retrofit"></a>`);
    await expect(panel.getByTestId("publish-saved")).toHaveText(/on \d{1,2} \w+ \d{4}\./);

    const context = await browser.newContext();
    const visitor = await context.newPage();
    const log = recordRequests(context);
    const response = await visitor.goto(pageUrl(CLAIM_HOST));
    expect(response?.status()).toBe(200);
    expect(response?.headers()["cache-control"]).toBe("private, no-store");
    expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(await response?.text()).not.toContain("/api/inference");
    const host = claimHostOf(CLAIM_HOST);
    await expect(visitor.getByTestId("published-by")).toHaveText(new RegExp(`^Published by the verified owner of ${host.replaceAll(".", "\\.")}\\. Saved on \\d{1,2} \\w+ \\d{4}\\.$`));
    await expect(visitor.getByTestId("score-total")).toHaveText(/^\d+$/);
    await expect(visitor.getByTestId("fix-first")).toBeVisible();
    await expect(visitor.getByTestId("check-aw.manifest")).toBeVisible();
    await expect(visitor).toHaveTitle(PUBLISHED_PAGE_TEXT.metaTitle(host));
    await expect(visitor.locator('link[rel="canonical"]')).toHaveAttribute("href", pageUrl(CLAIM_HOST));
    await expect(visitor.locator('meta[name="robots"]')).toHaveCount(0);
    await expect(visitor.getByLabel("Paste your key")).toBeVisible();
    await expect(visitor.getByText(/unofficial|private preview|free AI/i)).toHaveCount(0);
    expect(await context.cookies()).toEqual([]);

    const router = await mockOtari(visitor);
    await submitKey(visitor);
    const mount = visitor.getByTestId("preview-mount");
    await expect(mount.locator('[data-ns-slot="chat"]')).toBeVisible();
    await mount.getByRole("textbox").last().fill("What are your opening hours?");
    await mount.getByRole("textbox").last().press("Enter");
    await expect(mount.getByText(/Our opening hours are Monday to Friday 7:00 to 18:00/).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
    expect((await traceEvents(visitor)).filter((e) => e.kind === "tool").map((e) => e.tool)).toContain("website_search_site_content");
    expect(router.bodies.some((b) => b.messages.some((m) => m.role === "tool" && m.name === "website_search_site_content"))).toBe(true);
    await expect(visitor.getByText(/unofficial|private preview|free AI/i)).toHaveCount(0);

    const requests = await log.all();
    expect(requests.filter((r) => r.url.includes("/api/inference")).map((r) => r.url)).toEqual([]);
    const own = requests.filter((r) => r.origin === RETROFIT_ORIGIN);
    expect(own.filter((r) => r.url.includes(OTARI.key) || r.body.includes(OTARI.key) || Object.values(r.headers).some((v) => v.includes(OTARI.key)))).toEqual([]);
    expect(own.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.url}`)).toEqual([]);
    await context.close();

    const out = execFileSync(process.execPath, ["tools/agentic-web/scripts/check_partner.mjs", networkUrl(CLAIM_HOST)], { timeout: 15_000, encoding: "utf8" });
    expect(out).toContain("Its bridge shares no actions");
    expect(out).not.toMatch(/Error:|redirects to/);
  });

  // Fails if the badge is missing, cached wrongly or not embeddable, the sitemap misses the page, or unpublishing leaves any of them.
  test("the badge and the sitemap show a published site; unpublishing ends the page, the files, the badge and the sitemap entry", async ({ page, request }) => {
    await publishedOwner(page, CLAIM_HOST, "badge");
    const score = (await (await request.get(pageUrl(CLAIM_HOST))).text()).match(/data-testid="score-total">(\d+)</)?.[1];
    const badge = await request.get(badgeUrl(CLAIM_HOST));
    expect(badge.status()).toBe(200);
    expect(badge.headers()).toMatchObject({
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    expect(await badge.text()).toContain(`Agent-ready ${score}/100 · verified by Retrofit`);
    expect(await (await request.get("/sitemap.xml")).text()).toContain(`<loc>${pageUrl(CLAIM_HOST)}</loc>`);
    const manifest = await request.get(`${pageUrl(CLAIM_HOST)}/agent-manifest.json`);
    expect(manifest.headers()).toMatchObject({ "access-control-allow-origin": "*", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });

    // Another site can embed it.
    await page.goto(fixtureOrigin("bakery.fixture.test"));
    await page.evaluate((src) => {
      const img = document.createElement("img");
      img.id = "badge";
      img.crossOrigin = "anonymous";
      img.src = src;
      document.body.append(img);
    }, badgeUrl(CLAIM_HOST));
    await expect.poll(() => page.evaluate(() => (document.querySelector("#badge") as HTMLImageElement).naturalWidth)).toBeGreaterThan(100);

    await page.goto("/account");
    const panel = claimPanel(page, CLAIM_HOST);
    await panelButton(panel, PUBLISH_TEXT.unpublish).click();
    await expect(panel.getByTestId("claim-message")).toHaveText(PUBLISH_TEXT.unpublished);
    await expect(panelButton(panel, PUBLISH_TEXT.publish)).toBeEnabled();
    await expect(panel.getByTestId("claim-status")).toHaveText(/^Verified on /);
    for (const url of [pageUrl(CLAIM_HOST), `${pageUrl(CLAIM_HOST)}/agent-manifest.json`, `${networkUrl(CLAIM_HOST)}.network.json`, `${pageUrl(CLAIM_HOST)}/content-actions.js`, `${pageUrl(CLAIM_HOST)}/bridge/action-bridge.html`, badgeUrl(CLAIM_HOST)]) {
      expect((await request.get(url)).status(), url).toBe(404);
    }
    expect(await (await request.get("/sitemap.xml")).text()).not.toContain(pageUrl(CLAIM_HOST));
  });

  // The stuck states "Published refresh failed" and "Claim lapsed". Fails if a failed refresh changes the page, a lapse leaves it public, or
  // one passing check does not restore it.
  test("a failed refresh keeps the page; a lapse pauses it and one passing check restores it", async ({ page, request }) => {
    test.setTimeout(90_000);
    await publishedOwner(page, FLAKY_HOST, "lapse");
    const panel = claimPanel(page, FLAKY_HOST);
    await failRefresh(page, FLAKY_HOST);
    await expect(panel.getByTestId("publish-error")).toHaveText(`${PUBLISH_TEXT.lastRefreshFailed} ${PUBLISH_TEXT.refreshError.no_analysis(claimHostOf(FLAKY_HOST))}`);
    expect((await request.get(pageUrl(FLAKY_HOST))).status()).toBe(200);
    await page.reload();
    await expect(panel.getByTestId("publish-error")).toBeVisible();

    await lapseFlaky(request);
    await page.goto("/account");
    await expect(panel.getByTestId("publish-paused")).toHaveText(PUBLISH_TEXT.paused);
    await expect(panel.getByTestId("publish-link")).toHaveCount(0);
    for (const url of [pageUrl(FLAKY_HOST), `${pageUrl(FLAKY_HOST)}/agent-manifest.json`, badgeUrl(FLAKY_HOST)]) expect((await request.get(url)).status(), url).toBe(404);

    // The tag comes back: any token of this host's earlier claims plus this one's. Start over shows a new token.
    await panelButton(panel, CLAIMS_TEXT.startOver).click();
    await addClaimTag(request, FLAKY_HOST, await shownToken(panel));
    await checkAgain(panel);
    await expect(panel.getByTestId("claim-status")).toHaveText(/^Verified on /);
    await expect(panel.getByTestId("publish-link")).toBeVisible();
    for (const url of [pageUrl(FLAKY_HOST), badgeUrl(FLAKY_HOST)]) expect((await request.get(url)).status(), url).toBe(200);
  });

  // Fails if a host that is not published, or not in its exact form, answers anything but 404, or its 404 is indexable or cached.
  test("unknown and differently written hosts answer 404 for the page and the badge", async ({ page, request }) => {
    const response = await page.goto("/s/unknown.example.com");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: PUBLISHED_PAGE_TEXT.notFoundTitle })).toBeVisible();
    await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
    for (const path of ["/s/UNKNOWN.example.com", "/s/unknown.example.com:443", "/s/a%2Fb", "/badge/unknown.example.com.svg", "/badge/unknown"]) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
      expect(res.headers()["cache-control"], path).toMatch(/no-store/);
    }
  });

  // Fails if a path that only looks like a bridge file or a badge loses the page policy (the request hook's exclusion is too wide).
  test("a dot path after the bridge or badge folder keeps the page policy", async () => {
    for (const path of [
      "/s/x.example/bridge/../../account",
      "/s/x.example/bridge/..",
      "/s/x.example/bridge/%2e%2e/%2e%2e/sign-in",
      "/s/x.example/bridge/..%2f..%2faccount",
      "/s/x.example/bridge/a/../../../../sign-in",
      "/s/x.example/bridge/a.html/../../../../sign-in",
      "/s/x.example/bridge/a.html%2f..%2f..%2f..%2fsign-in",
      "/badge/..",
      "/badge/x.svg/../../sign-in",
      "/badge/%2e%2e%2fsign-in",
      "/badge/x/..svg",
    ]) {
      const { status, headers } = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        // The raw path: a URL parser would resolve the dots first.
        const req = http.request({ host: "127.0.0.1", port: 3010, path, method: "GET" }, (res) => (res.resume(), resolve({ status: res.statusCode ?? 0, headers: res.headers })));
        req.on("error", reject).end();
      });
      // A redirect to the cleaned path has no document; anything else must carry the page policy.
      if (status === 308) continue;
      const csp = String(headers["content-security-policy"] ?? "");
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).not.toContain("frame-ancestors *");
    }
  });

  // Origin isolation. Fails if a hostile site's published page, opened by a signed-in visitor, runs anything from the site or the model,
  // or sends any request but reads of its own files.
  test("a hostile site's published page is inert for a signed-in visitor", async ({ page, context }) => {
    test.setTimeout(90_000);
    await publishedByDns(page, "hostile.fixture.test", "hostile");
    const log = recordRequests(context);
    const router = await mockOtari(page, hostileScript(`Here is what the snapshot says. ${IMG} ${SCRIPT} ${JS_LINK} ![i](/api/auth/sign-out)`));
    const injected = await injectHostileContent(page, /\/s\/[^/]+\/site-content\.json$/);
    await page.goto(pageUrl("hostile.fixture.test"));
    await submitKey(page);
    const mount = page.getByTestId("preview-mount");
    await expect(mount.locator('[data-ns-slot="chat"]')).toBeVisible();
    await expect.poll(() => injected.served).toBeGreaterThanOrEqual(1);
    await mount.getByRole("textbox").last().fill("Tell me about your candles");
    await mount.getByRole("textbox").last().press("Enter");
    await expect(mount.locator(".ns-msg.bot").filter({ hasText: "Here is what the snapshot says." }).last()).toContainText(SCRIPT, { timeout: 20_000 });
    expect(router.bodies.some((b) => b.messages.some((m) => m.role === "tool" && (m.content ?? "").includes("__pwned")))).toBe(true);
    await expectInert(page, log, [RETROFIT_ORIGIN, new URL(OTARI.routerBase).origin]);
    const own = (await log.all()).filter((r) => r.origin === RETROFIT_ORIGIN);
    expect(own.filter((r) => r.method !== "GET" || /\/(account|auth|api)\b/.test(new URL(r.url).pathname)).map((r) => `${r.method} ${r.url}`)).toEqual([]);
    const badge = await (await page.request.get(badgeUrl("hostile.fixture.test"))).text();
    expect(badge).toMatch(/Agent-ready \d+\/100/);
    expect(badge).not.toMatch(/hostile|Ignore/i);
  });

  // Origin isolation. Fails if the published bridge shares any action with a site that frames it, answers it with anything but an empty
  // catalog, or the framing site can read the frame (the visitor is signed in on Retrofit).
  test("the published bridge gives a framing site no action and no access", async ({ page }) => {
    await publishedOwner(page, CLAIM_HOST, "bridge");
    await page.goto(fixtureOrigin("bakery.fixture.test"));
    const result = await page.evaluate(async (url) => {
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.src = url;
      const protocol = "nsdeploy-actions-v1";
      const ready = new Promise<MessagePort>((resolve) => {
        window.addEventListener("message", (e) => {
          if (e.source !== frame.contentWindow || e.data?.type !== "ready") return;
          const channel = new MessageChannel();
          frame.contentWindow!.postMessage({ protocol, type: "connect" }, new URL(url).origin, [channel.port2]);
          resolve(channel.port1);
        });
      });
      document.body.append(frame);
      const port = await ready;
      const ask = (message: Record<string, unknown>) =>
        new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
          port.onmessage = (e) => resolve(e.data);
          port.postMessage(message);
        });
      const catalog = await ask({ id: 1, type: "catalog" });
      const execute = await ask({ id: 2, type: "execute", name: "search_site_content", args: { query: "x" }, requestId: "r1" });
      let readable = false;
      try {
        readable = Boolean(frame.contentWindow?.document);
      } catch {
        readable = false;
      }
      return { catalog, execute, readable };
    }, `${pageUrl(CLAIM_HOST)}/bridge/action-bridge.html`);
    expect(result.catalog).toEqual({ id: 1, ok: true, value: [] });
    expect(result.execute).toMatchObject({ ok: false });
    expect(result.readable).toBe(false);
  });

  // P4-R1. Fails if a refresh inside the owner's hour is shown as a failed refresh, or does not say (in the owner's own time) when a
  // new read is possible; or a new analysis inside the hour changes that.
  test("a refresh inside the owner's hour says when a new read is possible, and is not a failed refresh", async ({ page }) => {
    test.setTimeout(60_000);
    await publishedOwner(page, CLAIM_HOST, "window");
    await analyzeFixture(page, CLAIM_HOST);
    await page.goto("/account");
    const panel = claimPanel(page, CLAIM_HOST);
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/publish");
    await panelButton(panel, PUBLISH_TEXT.refresh).click();
    const response = await answered;
    expect(response.status()).toBe(409);
    const { retryAt } = (await response.json()) as { retryAt: string };
    const ahead = Date.parse(retryAt) - Date.now();
    expect(ahead).toBeGreaterThan(0);
    expect(ahead).toBeLessThanOrEqual(3600_000 + 60_000);
    const local = await page.evaluate((iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }), retryAt);
    await expect(panel.getByTestId("claim-message")).toHaveText(new RegExp(`Retrofit reads a site again for its verified owner 60 minutes after the last read, so a new analysis brings nothing newer before ${local}\\. Analyze it again after that, then refresh\\.$`));
    await expect(panel.getByTestId("publish-error")).toHaveCount(0);
    await expect(panelButton(panel, PUBLISH_TEXT.refresh)).toBeEnabled();
    await page.reload();
    await expect(panel.getByTestId("publish-error")).toHaveCount(0);
  });

  // P4-R4. Fails if an outage answers below 500, as a 404, cached, indexable, without the text and the retry, or with any internal detail.
  test("an account data outage answers 5xx with the unavailable text and a retry that recovers", async ({ page }) => {
    await publishedOwner(page, CLAIM_HOST, "outage");
    await setOutage(page, true);
    const raw = await page.request.get(pageUrl(CLAIM_HOST));
    expect(raw.status()).toBeGreaterThanOrEqual(500);
    expect(raw.headers()["cache-control"]).toMatch(/no-store/);
    expect(await raw.text()).toMatch(/<meta name="robots" content="noindex/);
    expect(await raw.text()).not.toMatch(/fixture_outage|AccountDataUnavailable|getPublicReport|published by/i);
    const response = await page.goto(pageUrl(CLAIM_HOST));
    expect(response?.status()).toBeGreaterThanOrEqual(500);
    await expect(page.getByRole("heading", { level: 1, name: PUBLISHED_PAGE_TEXT.unavailableTitle })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: PUBLISHED_PAGE_TEXT.unavailable })).toBeVisible();
    await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
    await expect(page.locator("body")).not.toContainText(/fixture_outage|AccountDataUnavailable|digest/i);
    for (const url of [`${pageUrl(CLAIM_HOST)}/agent-manifest.json`, badgeUrl(CLAIM_HOST)]) {
      const res = await page.request.get(url);
      expect(res.status(), url).toBe(503);
      expect(res.headers()["cache-control"], url).toMatch(/no-store/);
    }
    expect((await page.request.get("/sitemap.xml")).status()).toBe(200);
    await setOutage(page, false);
    await page.getByRole("button", { name: PUBLISHED_PAGE_TEXT.tryAgain }).click();
    await expect(page.getByTestId("published-by")).toBeVisible();
  });

  // P4 review, item 7. Fails if a key saved elsewhere on Retrofit (in this tab or on this device) connects on a published page without a
  // click, reaches any provider before it, or a click on one host counts for another host or a later load.
  test("a saved key is used on a published page only after a click, on every load and every host", async ({ page, browser }) => {
    test.setTimeout(90_000);
    await publishedOwner(page, CLAIM_HOST, "saved-a");
    await publishedByDns(page, "plain.fixture.test", "saved-b");
    for (const store of ["sessionStorage", "localStorage"] as const) {
      const context = await browser.newContext();
      const visitor = await context.newPage();
      const router = await mockOtari(visitor);
      const log = recordRequests(context);
      await saveTestKey(visitor, store);
      const quiet = async () => {
        await expect(visitor.getByRole("button", { name: "Use your saved key" })).toBeVisible();
        // Give a connection by itself the time it would need.
        await visitor.waitForTimeout(1_000);
        await expect(visitor.getByTestId("preview-mount")).toHaveCount(0);
        await expect(visitor.getByText(/Connected to/)).toHaveCount(0);
        expect(await visitor.evaluate(() => (window as { __nsweb?: unknown }).__nsweb === undefined)).toBe(true);
        expect(await visitor.locator("body").innerHTML()).not.toContain(OTARI.key);
      };
      const providerRequests = async () => (await log.all()).filter((r) => r.origin !== RETROFIT_ORIGIN).map((r) => r.url);

      await visitor.goto(pageUrl(CLAIM_HOST));
      await quiet();
      expect(await providerRequests(), store).toEqual([]);
      expect([router.modelRequests, router.probes.length, router.bodies.length]).toEqual([0, 0, 0]);

      await visitor.getByRole("button", { name: "Use your saved key" }).click();
      await expect(visitor.getByText(/Connected to Otari/)).toBeVisible();
      await expect(visitor.getByTestId("preview-mount").locator('[data-ns-slot="chat"]')).toBeVisible();
      await expect(visitor.getByRole("button", { name: "Use your saved key" })).toHaveCount(0);
      expect(router.probes.length).toBeGreaterThan(0);

      // Another host, and the same host again, ask again.
      for (const host of ["plain.fixture.test", CLAIM_HOST]) {
        const before = (await providerRequests()).length;
        await visitor.goto(pageUrl(host));
        await quiet();
        expect((await providerRequests()).length, host).toBe(before);
      }
      await context.close();
    }
  });

  // Fails if an expired analysis can be published, the owner is not told to analyze again, or a newer analysis does not refresh the page.
  test("with no unexpired analysis a refresh says to analyze first, and a new analysis then refreshes the page", async ({ page }) => {
    await publishedOwner(page, CLAIM_HOST, "again");
    const panel = claimPanel(page, CLAIM_HOST);
    // The analysis expires after 7 days; the claim and the publication stay.
    await setClockOffset(page.request, 8 * 24 * 3600_000);
    await panelButton(panel, PUBLISH_TEXT.refresh).click();
    await expect(panel.getByTestId("claim-message")).toHaveText(PUBLISH_TEXT.refreshError.no_analysis(claimHostOf(CLAIM_HOST)));
    await analyzeFixture(page, CLAIM_HOST);
    await page.goto("/account");
    await panelButton(panel, PUBLISH_TEXT.tryAgain).click();
    await expect(panel.getByTestId("claim-message")).toHaveText(PUBLISH_TEXT.refreshed);
    await expect(panel.getByTestId("publish-error")).toHaveCount(0);
  });
});
