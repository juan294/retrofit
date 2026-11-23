import type { Page } from "@playwright/test";
import { expect } from "../fixtures/csp";
import { SIGN_IN_TEXT } from "@/lib/site/sign-in-texts";

/** A new address per call, so specs never share an account. */
export const newEmail = (label: string) => `e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

/** The newest sign-in link the fixture provider "emailed" to `email` (fixtures mode only). */
export async function mailboxLink(page: Page, email: string): Promise<string> {
  const res = await page.request.get(`/test-fixtures/mailbox?email=${encodeURIComponent(email)}`);
  expect(res.status(), "a sign-in link was sent").toBe(200);
  return ((await res.json()) as { link: string }).link;
}

/** Asks for a link on the open sign-in page and waits for the "check your email" answer. */
export async function askForLink(page: Page, email: string): Promise<string> {
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /Email me a sign-in link|Send the link again/ }).click();
  await expect(page.getByRole("status")).toHaveText(SIGN_IN_TEXT.sent);
  return mailboxLink(page, email);
}

/** Signs in through /sign-in and the fixture mailbox; lands on `returnTo` (default /account). */
export async function signIn(page: Page, email: string, returnTo?: string): Promise<void> {
  await page.goto(returnTo ? `/sign-in?returnTo=${encodeURIComponent(returnTo)}` : "/sign-in");
  await page.goto(await askForLink(page, email));
  await expect(page).toHaveURL(new RegExp(`${(returnTo ?? "/account").replace(/[/?]/g, "\\$&")}$`));
}
