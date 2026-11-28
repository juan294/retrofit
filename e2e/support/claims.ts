import type { APIRequestContext, Browser, Locator, Page } from "@playwright/test";
import { expect } from "../fixtures/csp";
import { CLAIM_TXT_LABEL, CLAIM_TXT_PREFIX } from "@/lib/claims/names";
import { CLAIMS_TEXT } from "@/lib/site/claims-texts";
import { newEmail, signIn } from "./account";
import { analyzeFixture } from "./agent";
import { CLAIM_TAG_URL, fixtureOrigin } from "./global-setup";

/** Fixture hosts for claims (global-setup.ts): two that serve registered tags, robots-blocked, no tag, and a plain copy. */
export const CLAIM_HOST = "claim.fixture.test";
export const FLAKY_HOST = "flaky.fixture.test";
export const BLOCKED_HOST = "blocked.fixture.test";
/** Claimed by meta in claimStates with no tag on the site: the plain "tag not found" pending state. */
export const MISSING_HOST = "agentified.fixture.test";
/** Claimed by DNS last in claimStates, so its panel shows the new token. */
export const FRESH_HOST = "plain.fixture.test";
/** playwright.config.ts gives the test server this CRON_SECRET. */
const CRON_SECRET = "cron-secret-e2e-only-0123456789";
const DAY_MS = 24 * 3600_000;

/** The claim host of a fixture site (its analysis origin has the fixture port). */
export const claimHostOf = (host: string) => new URL(fixtureOrigin(host)).host;

/** The panel of the claim for `host` on /account. */
export const claimPanel = (page: Page, host: string): Locator => page.locator(`[data-testid="claim"][data-host="${claimHostOf(host)}"]`);

/** A panel's button by its text: its accessible name is the text and then the panel's host. */
export const panelButton = (panel: Locator, label: string): Locator => panel.getByRole("button", { name: new RegExp(`^${label}: `) });

/** Analyzes a fixture site; the robots-blocked one settles on its failure text instead of a score. */
export const analyzeAny = (page: Page, host: string) =>
  analyzeFixture(page, host, host === BLOCKED_HOST ? (p) => p.getByText("This site asks automated tools not to read it.", { exact: false }) : undefined);

/** The token a panel shows right after a claim or Start over (from the tag or the TXT value). */
export async function shownToken(panel: Locator): Promise<string> {
  const text = (await panel.getByTestId("claim-token").locator("code").textContent()) ?? "";
  const token = /[0-9a-f]{32}/.exec(text)?.[0];
  expect(token, "the panel shows a token").toBeDefined();
  return token as string;
}

/** On /account, claims the recent analysis of `host` by `method`; returns its panel and the token it shows. */
export async function claimSite(page: Page, host: string, method: "meta" | "dns"): Promise<{ panel: Locator; token: string }> {
  await page.goto("/account");
  await page.getByLabel(CLAIMS_TEXT.sourceLabel).selectOption({ label: CLAIMS_TEXT.sourceFromAnalysis(claimHostOf(host)) });
  await page.getByLabel(method === "meta" ? CLAIMS_TEXT.methodMeta : CLAIMS_TEXT.methodDns).check();
  await page.getByRole("button", { name: CLAIMS_TEXT.claimButton }).click();
  const panel = claimPanel(page, host);
  await expect(panel.getByTestId("claim-token")).toBeVisible();
  await expect(panel.getByTestId("claim-message")).toHaveText(CLAIMS_TEXT.addShown[method]);
  await expect(page.getByTestId("claims-message")).toHaveText(CLAIMS_TEXT.created);
  return { panel, token: await shownToken(panel) };
}

/** Chooses Check again on a panel and waits for the answer. */
export async function checkAgain(panel: Locator): Promise<void> {
  await panelButton(panel, CLAIMS_TEXT.checkAgain).click();
  await expect(panel.getByTestId("claim-message")).toBeVisible();
}

/** Puts the tag for `token` on a tagged fixture host's home page (global-setup.ts). */
export async function addClaimTag(request: APIRequestContext, host: string, token: string): Promise<void> {
  expect((await request.get(CLAIM_TAG_URL("add", host, token))).status()).toBe(200);
}

/** Removes every tag from a tagged fixture host's home page. */
export async function clearClaimTags(request: APIRequestContext, host: string): Promise<void> {
  expect((await request.get(CLAIM_TAG_URL("clear", host))).status()).toBe(200);
}

/** Publishes the DNS record for `token` on `host` through the fixtures TXT store (split in two strings, beside an unrelated record). */
export async function publishTxt(request: APIRequestContext, host: string, token: string): Promise<void> {
  const res = await request.post("/test-fixtures/txt", { data: { name: `${CLAIM_TXT_LABEL}.${host}`, records: [["v=spf1 -all"], [CLAIM_TXT_PREFIX, token]] } });
  expect(res.status()).toBe(200);
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
 * Lapses the verified flaky claim: its tags go away and three daily rechecks fail (the server clock
 * moves a day and a bit before each). The clock offset stays at the last day; the caller resets it.
 */
export async function lapseFlaky(request: APIRequestContext): Promise<void> {
  await clearClaimTags(request, FLAKY_HOST);
  for (let day = 1; day <= 3; day++) {
    await setClockOffset(request, day * (DAY_MS + 3600_000));
    await runRecheck(request);
  }
}

/** Answers the POST to `path` with the hourly limit (the 429 the route gives, with its text), for the layout and color checks. */
export async function mockLimit(page: Page, path: string, text: (retryAt: Date) => string): Promise<void> {
  const retryAt = new Date(Date.now() + 3600_000);
  await page.route(`**${path}`, (route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "limit", message: text(retryAt), retryAt: retryAt.toISOString() }) }));
}

/** Claims `host` by meta, registers the tag and checks it: verified. */
export async function verifyByTag(page: Page, host: string): Promise<void> {
  const { panel, token } = await claimSite(page, host, "meta");
  await addClaimTag(page.request, host, token);
  await checkAgain(panel);
  await expect(panel.getByTestId("claim-status")).toHaveText(/^Verified on /);
}

/** Claims `host` by DNS, publishes the record and checks it: verified. Any fixture host. */
export async function verifyByDns(page: Page, host: string): Promise<void> {
  const { panel, token } = await claimSite(page, host, "dns");
  await publishTxt(page.request, host, token);
  await checkAgain(panel);
  await expect(panel.getByTestId("claim-status")).toHaveText(/^Verified on /);
}

/**
 * An account with a claim in each state, for the layout and color checks: the flaky site lapsed, the
 * robots-blocked site pending with the DNS hint, the claim site superseded by a second account, the
 * agentified site pending with "no tag found", and the plain bakery copy just claimed by DNS with its
 * token shown. Returns the second account's page, where the claim site is verified. Leaves the server
 * clock at zero.
 */
export async function claimStates(page: Page, browser: Browser, label: string): Promise<{ other: Page; close: () => Promise<void> }> {
  const request = page.request;
  try {
    await signIn(page, newEmail(`claims-${label}`));
    // bakery stays unclaimed, so the claim form stays on the page.
    for (const host of [FLAKY_HOST, BLOCKED_HOST, CLAIM_HOST, MISSING_HOST, FRESH_HOST, "bakery.fixture.test"]) await analyzeAny(page, host);

    await verifyByTag(page, FLAKY_HOST);
    await lapseFlaky(request);
    await setClockOffset(request, 0);

    await checkAgain((await claimSite(page, BLOCKED_HOST, "meta")).panel);
    await expect(claimPanel(page, BLOCKED_HOST).getByTestId("claim-reason")).toHaveText(CLAIMS_TEXT.reason("robots_blocked", "meta", { host: "", url: "", recordName: "" }, null));
    await verifyByTag(page, CLAIM_HOST);
  } finally {
    await setClockOffset(request, 0);
  }

  const context = await browser.newContext();
  const other = await context.newPage();
  await signIn(other, newEmail(`claims-${label}-other`));
  await analyzeAny(other, CLAIM_HOST);
  await verifyByTag(other, CLAIM_HOST);

  await page.goto("/account");
  await expect(claimPanel(page, CLAIM_HOST).getByTestId("claim-status")).toHaveText(/^Ownership moved to another account on /);
  await expect(claimPanel(page, FLAKY_HOST).getByTestId("claim-status")).toHaveText(/^Verification failed on \d{1,2} \w+ \d{4}\.$/);
  await checkAgain((await claimSite(page, MISSING_HOST, "meta")).panel);
  await expect(claimPanel(page, MISSING_HOST).getByTestId("claim-reason")).toContainText("found no retrofit-site-verification tag");
  // A reload drops the token, so the panel shows the plain pending state.
  await page.goto("/account");
  await expect(claimPanel(page, MISSING_HOST).getByTestId("claim-token")).toHaveCount(0);
  await claimSite(page, FRESH_HOST, "dns");
  return { other, close: () => context.close() };
}
