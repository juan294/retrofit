import { expect, type Page } from "@playwright/test";

/** No sideways scrolling: the document is exactly as wide as the window. */
export async function fits(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
}
