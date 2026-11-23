import type { Browser, Page } from "@playwright/test";
import { expect } from "../fixtures/csp";
import { PUBLISH_TEXT } from "@/lib/site/publish-texts";
import { newEmail, signIn } from "./account";
import { OTARI } from "./agent";
import { analyzeAny, checkAgain, claimHostOf, claimPanel, claimSite, FLAKY_HOST, publishTxt, verifyByTag, lapseFlaky, setClockOffset } from "./claims";

export const ORIGIN = "http://127.0.0.1:3010";
/** The public page of a fixture host. */
export const pageUrl = (host: string) => `${ORIGIN}/s/${claimHostOf(host)}`;
export const badgeUrl = (host: string) => `${ORIGIN}/badge/${claimHostOf(host)}.svg`;

/** Chooses Publish on the host's panel (open on /account) and waits for the answer. */
export async function publishOn(page: Page, host: string): Promise<void> {
  const panel = claimPanel(page, host);
  await panel.getByRole("button", { name: PUBLISH_TEXT.publish, exact: true }).click();
  await expect(panel.getByTestId("claim-message")).toHaveText(PUBLISH_TEXT.published);
  await expect(panel.getByTestId("publish-link")).toHaveAttribute("href", pageUrl(host));
}

/** A new signed-in account that analyzed `host` and claimed it by tag. Ends on /account. */
export async function verifiedOwner(page: Page, host: string, label: string): Promise<void> {
  await signIn(page, newEmail(`publish-${label}`));
  await analyzeAny(page, host);
  await verifyByTag(page, host);
}

/** A verifiedOwner that published `host`. Ends on /account. */
export async function publishedOwner(page: Page, host: string, label: string): Promise<void> {
  await verifiedOwner(page, host, label);
  await publishOn(page, host);
}

/** Answers Publish with the hourly limit (the 429 the route gives), for the layout and color checks. */
export async function mockPublishLimit(page: Page): Promise<void> {
  const retryAt = new Date(Date.now() + 3600_000);
  await page.route("**/api/publish", (route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "limit", message: PUBLISH_TEXT.limit(retryAt), retryAt: retryAt.toISOString() }) }));
}

/** As publishedOwner, with a DNS claim (any fixture host). */
export async function publishedByDns(page: Page, host: string, label: string): Promise<void> {
  await signIn(page, newEmail(`publish-${label}`));
  await analyzeAny(page, host);
  const { panel, token } = await claimSite(page, host, "dns");
  await publishTxt(page.request, host, token);
  await checkAgain(panel);
  await expect(panel.getByTestId("claim-status")).toHaveText(/^Verified on /);
  await publishOn(page, host);
}

/** Connects the Otari test key on a published page. Its key form is open at once: there is no free AI to wait for. */
export async function connectOwnKey(page: Page): Promise<void> {
  await page.getByLabel("Paste your key").fill(OTARI.key);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(/Connected to Otari/)).toBeVisible();
}

/** Refreshes with no new analysis, so the panel shows the failed refresh. */
export async function failRefresh(page: Page, host: string): Promise<void> {
  const panel = claimPanel(page, host);
  await panel.getByRole("button", { name: PUBLISH_TEXT.refresh, exact: true }).click();
  await expect(panel.getByTestId("publish-error")).toBeVisible();
  await expect(panel.getByRole("button", { name: PUBLISH_TEXT.tryAgain, exact: true })).toBeEnabled();
}

/**
 * The publish states for the layout and color checks: the flaky site published, its refresh failed (shown on
 * /account in `page`), and its public page open in a new browser. `pause` then lapses it and reloads /account.
 */
export async function publishStates(page: Page, browser: Browser, label: string): Promise<{ visitor: Page; pause: () => Promise<void>; close: () => Promise<void> }> {
  await publishedOwner(page, FLAKY_HOST, label);
  await failRefresh(page, FLAKY_HOST);
  const context = await browser.newContext();
  const visitor = await context.newPage();
  await visitor.goto(pageUrl(FLAKY_HOST));
  await expect(visitor.getByTestId("published-by")).toBeVisible();
  return {
    visitor,
    pause: async () => {
      try {
        await lapseFlaky(page.request);
      } finally {
        await setClockOffset(page.request, 0);
      }
      await page.goto("/account");
      await expect(claimPanel(page, FLAKY_HOST).getByTestId("publish-paused")).toHaveText(PUBLISH_TEXT.paused);
    },
    close: () => context.close(),
  };
}
