import type { Browser, Page } from "@playwright/test";
import { expect } from "../fixtures/csp";
import { KEY_ITEM } from "@/lib/keys/storage";
import { PUBLISH_TEXT } from "@/lib/site/publish-texts";
import { newEmail, signIn } from "./account";
import { OTARI } from "./agent";
import { analyzeAny, claimHostOf, claimPanel, FLAKY_HOST, lapseFlaky, setClockOffset, verifyByDns, verifyByTag, panelButton } from "./claims";
import { RETROFIT_ORIGIN } from "./extra-requests";

/** The public page of a fixture host. */
export const pageUrl = (host: string) => `${RETROFIT_ORIGIN}/s/${claimHostOf(host)}`;
export const badgeUrl = (host: string) => `${RETROFIT_ORIGIN}/badge/${claimHostOf(host)}.svg`;

/** Chooses Publish on the host's panel (open on /account) and waits for the answer. */
export async function publishOn(page: Page, host: string): Promise<void> {
  const panel = claimPanel(page, host);
  await panelButton(panel, PUBLISH_TEXT.publish).click();
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

/** As publishedOwner, with a DNS claim (any fixture host). */
export async function publishedByDns(page: Page, host: string, label: string): Promise<void> {
  await signIn(page, newEmail(`publish-${label}`));
  await analyzeAny(page, host);
  await verifyByDns(page, host);
  await publishOn(page, host);
}

/** Refreshes after the analysis expired (7 days; the clock goes back afterwards), so the panel shows the failed refresh. */
export async function failRefresh(page: Page, host: string): Promise<void> {
  const panel = claimPanel(page, host);
  try {
    await setClockOffset(page.request, 8 * 24 * 3600_000);
    await panelButton(panel, PUBLISH_TEXT.refresh).click();
    await expect(panel.getByTestId("publish-error")).toBeVisible();
  } finally {
    await setClockOffset(page.request, 0);
  }
  await expect(panelButton(panel, PUBLISH_TEXT.tryAgain)).toBeEnabled();
}

/** Turns the account data outage on or off (fixtures mode). */
export async function setOutage(page: Page, on: boolean): Promise<void> {
  expect((await page.request.post("/test-fixtures/outage", { data: { on } })).status()).toBe(200);
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

/** Saves the Otari test key in this tab, as the key panel does after a connect elsewhere on Retrofit. */
export async function saveTestKey(page: Page, store: "sessionStorage" | "localStorage" = "sessionStorage"): Promise<void> {
  await page.goto("/bot");
  const value = JSON.stringify({ provider: "Otari", router: OTARI.routerBase, model: OTARI.model, key: OTARI.key });
  await page.evaluate(({ store, item, value }) => window[store].setItem(item, value), { store, item: KEY_ITEM, value });
}
