import type { APIRequestContext, Browser, Locator, Page } from "@playwright/test";
import { expect } from "../fixtures/csp";
import { CLAIMS_TEXT } from "@/lib/site/claims-texts";
import { newEmail, signIn } from "./account";
import { analyzeFixture } from "./agent";
import { CLAIM_TAG_SWITCH, fixtureOrigin } from "./global-setup";

/** Fixture hosts for claims (global-setup.ts): the tag always there, the tag switchable, robots-blocked (DNS record in fixtures mode). */
export const CLAIM_HOST = "claim.fixture.test";
export const FLAKY_HOST = "flaky.fixture.test";
export const BLOCKED_HOST = "blocked.fixture.test";
/** playwright.config.ts gives the test server this CRON_SECRET. */
const CRON_SECRET = "cron-secret-e2e-only-0123456789";
const DAY_MS = 24 * 3600_000;

/** The claim host of a fixture site (its analysis origin has the fixture port). */
export const claimHostOf = (host: string) => new URL(fixtureOrigin(host)).host;

/** The panel of the claim for `host` on /account. */
export const claimPanel = (page: Page, host: string): Locator => page.locator(`[data-testid="claim"][data-host="${claimHostOf(host)}"]`);

/** Starts an analysis of a fixture site and waits for its results page to settle (a score, or a failure text). */
export async function analyzeAny(page: Page, host: string): Promise<void> {
  if (host !== BLOCKED_HOST) {
    await analyzeFixture(page, host);
    return;
  }
  await page.goto("/");
  await page.getByLabel("Your website address").fill(fixtureOrigin(host));
  await page.getByRole("button", { name: "Score my site" }).click();
  await expect(page).toHaveURL(/\/r\/[0-9a-f]{32}$/);
  await expect(page.getByText("This site asks automated tools not to read it.", { exact: false })).toBeVisible({ timeout: 30_000 });
}

/** On /account, claims the recent analysis of `host` by `method`; returns its panel, which shows the token. */
export async function claimSite(page: Page, host: string, method: "meta" | "dns"): Promise<Locator> {
  await page.goto("/account");
  await page.getByLabel(CLAIMS_TEXT.sourceLabel).selectOption({ label: CLAIMS_TEXT.sourceFromAnalysis(claimHostOf(host)) });
  await page.getByLabel(method === "meta" ? CLAIMS_TEXT.methodMeta : CLAIMS_TEXT.methodDns).check();
  await page.getByRole("button", { name: CLAIMS_TEXT.claimButton }).click();
  const panel = claimPanel(page, host);
  await expect(panel.getByTestId("claim-token")).toBeVisible();
  await expect(panel.getByTestId("claim-message")).toHaveText(CLAIMS_TEXT.created);
  return panel;
}

/** Chooses Check again on a panel and waits for the answer. */
export async function checkAgain(panel: Locator): Promise<void> {
  await panel.getByRole("button", { name: CLAIMS_TEXT.checkAgain }).click();
  await expect(panel.getByTestId("claim-message")).toBeVisible();
}

/** Turns the flaky fixture site's tag on or off. */
export async function setFlakyTag(request: APIRequestContext, on: boolean): Promise<void> {
  expect((await request.get(CLAIM_TAG_SWITCH(on))).status()).toBe(200);
}

/** Moves the server clock by `offsetMs` (fixtures mode). */
export async function setClockOffset(request: APIRequestContext, offsetMs: number): Promise<void> {
  expect((await request.post("/test-fixtures/clock", { data: { offsetMs } })).status()).toBe(200);
}

/** One daily recheck run, as Vercel Cron calls it. */
export async function runRecheck(request: APIRequestContext): Promise<{ checked: number; lapsed: number }> {
  const res = await request.get("/api/cron/claims", { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  expect(res.status()).toBe(200);
  return (await res.json()) as { checked: number; lapsed: number };
}

/**
 * Lapses the verified flaky claim: the tag goes away and three daily rechecks fail (the server clock
 * moves a day and a bit before each). The clock offset stays at the last day; the caller resets it.
 */
export async function lapseFlaky(request: APIRequestContext): Promise<void> {
  await setFlakyTag(request, false);
  for (let day = 1; day <= 3; day++) {
    await setClockOffset(request, day * (DAY_MS + 3600_000));
    await runRecheck(request);
  }
}

/**
 * An account with a claim in each state, for the layout and color checks: the flaky site lapsed, the
 * robots-blocked site pending with the DNS hint, the bakery copy superseded by a second account, and
 * the agentified site just claimed by DNS with its token shown. Returns the second account's page,
 * where the bakery copy is verified. Leaves the server clock at zero and the flaky tag on.
 */
export async function claimStates(page: Page, browser: Browser, label: string): Promise<{ other: Page; close: () => Promise<void> }> {
  const request = page.request;
  try {
    await signIn(page, newEmail(`claims-${label}`));
    // bakery stays unclaimed, so the claim form stays on the page.
    for (const host of [FLAKY_HOST, BLOCKED_HOST, CLAIM_HOST, "agentified.fixture.test", "bakery.fixture.test"]) await analyzeAny(page, host);

    await setFlakyTag(request, true);
    await checkAgain(await claimSite(page, FLAKY_HOST, "meta"));
    await expect(claimPanel(page, FLAKY_HOST).getByTestId("claim-status")).toHaveText(/^Verified on /);
    await lapseFlaky(request);
    await setClockOffset(request, 0);

    await checkAgain(await claimSite(page, BLOCKED_HOST, "meta"));
    await expect(claimPanel(page, BLOCKED_HOST).getByTestId("claim-reason")).toHaveText(CLAIMS_TEXT.reason("robots_blocked", "meta", { host: "", url: "", recordName: "" }, null));
    await checkAgain(await claimSite(page, CLAIM_HOST, "meta"));
    await expect(claimPanel(page, CLAIM_HOST).getByTestId("claim-status")).toHaveText(/^Verified on /);
  } finally {
    await setClockOffset(request, 0);
    await setFlakyTag(request, true);
  }

  const context = await browser.newContext();
  const other = await context.newPage();
  await signIn(other, newEmail(`claims-${label}-other`));
  await analyzeAny(other, CLAIM_HOST);
  await checkAgain(await claimSite(other, CLAIM_HOST, "meta"));
  await expect(claimPanel(other, CLAIM_HOST).getByTestId("claim-status")).toHaveText(/^Verified on /);

  await page.goto("/account");
  await expect(claimPanel(page, CLAIM_HOST).getByTestId("claim-status")).toHaveText(/^Ownership moved to another account on /);
  await expect(claimPanel(page, FLAKY_HOST).getByTestId("claim-status")).toHaveText(/^Verification failed on .*Your published page and badge are paused\.$/);
  await claimSite(page, "agentified.fixture.test", "dns");
  return { other, close: () => context.close() };
}
