import { expect } from "@playwright/test";
import { hasEmoji } from "../../public/brand/runtime-icons.js";

type Locator = import("@playwright/test").Locator;

/** The runtime under `root` shows each named Retrofit icon, and none of its text, hidden or shown, has an emoji. */
export async function expectIconsWithoutEmoji(root: Locator, icons: readonly string[]): Promise<void> {
  for (const icon of icons) await expect(root.locator(`svg.rf-icon[data-icon="${icon}"]`).first(), icon).toBeVisible();
  const text = await root.evaluate((el) => el.textContent ?? "");
  expect(hasEmoji(text), text).toBe(false);
}
