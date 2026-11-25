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

/** Opens an emailed link and chooses Sign in on the confirm page it shows. */
export async function openLink(page: Page, link: string): Promise<void> {
  await page.goto(link);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SIGN_IN_TEXT.confirmTitle);
  await page.getByRole("button", { name: SIGN_IN_TEXT.confirmButton }).click();
}

/** Signs in through /sign-in, the fixture mailbox and the confirm page; lands on `returnTo` (default /account). */
export async function signIn(page: Page, email: string, returnTo?: string): Promise<void> {
  await page.goto(returnTo ? `/sign-in?returnTo=${encodeURIComponent(returnTo)}` : "/sign-in");
  await openLink(page, await askForLink(page, email));
  await expect(page).toHaveURL(new RegExp(`${(returnTo ?? "/account").replace(/[/?]/g, "\\$&")}$`));
}

/** A well-formed confirm link (the page checks only its shape; nothing is verified until Sign in). */
export const CONFIRM_PATH = `/auth/confirm?token_hash=${"a".repeat(56)}&type=email`;

/** Reaches the address step: a link opened by a browser that did not ask for it (its sign-in cookie is gone). Returns the address. */
export async function addressStep(page: Page): Promise<string> {
  const email = newEmail("address-step");
  await page.goto("/sign-in");
  const link = await askForLink(page, email);
  await page.context().clearCookies({ name: "retrofit_signin" });
  await openLink(page, link);
  await expect(page.getByTestId("confirm-address")).toHaveText(email);
  return email;
}

/** The sign-in form's states: `sent` (a real send), and `limit` or `error` answered by a mocked API. Returns the message element. */
export async function signInFormState(page: Page, state: "sent" | "limit" | "error") {
  await page.goto("/sign-in");
  if (state !== "sent") {
    const retryAt = new Date(Date.now() + 3600_000);
    const body = state === "limit" ? { error: "limit", message: SIGN_IN_TEXT.limit(retryAt), retryAt: retryAt.toISOString() } : { error: "mail_unavailable", message: SIGN_IN_TEXT.mailUnavailable };
    await page.route("**/api/auth/sign-in", (route) => route.fulfill({ status: state === "limit" ? 429 : 503, contentType: "application/json", body: JSON.stringify(body) }));
  }
  await page.getByLabel("Email").fill(newEmail(`state-${state}`));
  await page.getByRole("button", { name: SIGN_IN_TEXT.submit }).click();
  const message = page.locator("#sign-in-status");
  await expect(message).toBeVisible();
  return message;
}
