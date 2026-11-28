/**
 * A host moving between accounts (parent plan, "Ownership claims"; success criterion 4): two
 * accounts may hold pending claims for one host; the first to verify wins; a later verification
 * by another account moves the host and records the change; the earlier claim is superseded and
 * never comes back. DNS checks use a fake TXT resolver.
 */
import { describe, expect, it } from "vitest";
import { handleCheckClaim, handleCreateClaim } from "@/lib/api/claims";
import { recheckDueClaims } from "@/lib/claims/recheck";
import { claimView, type ClaimView } from "@/lib/claims/view";
import { sha256Hex } from "@/lib/security/tokens";
import { CLAIMS_TEXT } from "@/lib/site/claims-texts";
import { accountCookie, fakeClock, OTHER_ACCOUNT, postRequest, storeAnalysis, testDeps, TEST_ACCOUNT } from "../helpers/server-deps";

const HOST = "shop.example.com";

async function twoAccounts() {
  const clock = fakeClock(Date.parse("2026-11-23T10:00:00.000Z"));
  const records: string[][] = [];
  const d = testDeps({ clock: clock.clock, txt: async () => records });
  const accounts = { first: { ...TEST_ACCOUNT, cookie: await accountCookie(d, TEST_ACCOUNT) }, second: { ...OTHER_ACCOUNT, cookie: await accountCookie(d, OTHER_ACCOUNT) } };
  /** Each account analyzed the host, then claims it by DNS; returns the claim id and token. */
  const claim = async (who: keyof typeof accounts) => {
    const { id } = await storeAnalysis(d, { inputOrigin: `https://${HOST}`, accountId: accounts[who].userId, ownerHash: sha256Hex(who) });
    const body = (await (await handleCreateClaim(postRequest("/api/claims", { source: `analysis:${id}`, method: "dns" }, { cookie: accounts[who].cookie }), d)).json()) as { claim: ClaimView; token: string };
    return { id: body.claim.id, token: body.token };
  };
  const check = async (who: keyof typeof accounts, claimId: string) => handleCheckClaim(postRequest("/api/claims/check", { claimId }, { cookie: accounts[who].cookie }), d);
  const publish = (token: string) => records.splice(0, records.length, [`retrofit-site-verification=${token}`]);
  return { d, clock, accounts, claim, check, publish, records };
}

describe("a host moves to the account that verifies it later", () => {
  // Fails if two pending claims for one host cannot coexist, or the first verification does not win the host.
  it("two accounts hold pending claims for one host; the first to verify holds it", async () => {
    const { d, claim, check, publish } = await twoAccounts();
    const first = await claim("first");
    const second = await claim("second");
    publish(first.token);
    expect((await check("first", first.id)).status).toBe(200);
    expect((await d.accounts.getClaim(TEST_ACCOUNT.userId, first.id))?.status).toBe("verified");
    expect((await d.accounts.getClaim(OTHER_ACCOUNT.userId, second.id))?.status).toBe("pending");
  });

  // Fails if a second account's verification does not move the host, record the date, or show the first account the moved text.
  it("a second account's verification moves the host and the first account sees the change with its date", async () => {
    const { d, clock, claim, check, publish } = await twoAccounts();
    const first = await claim("first");
    const second = await claim("second");
    publish(first.token);
    await check("first", first.id);
    clock.set(Date.parse("2026-11-25T08:30:00.000Z"));
    publish(second.token);
    const moved = (await (await check("second", second.id)).json()) as { claim: ClaimView };
    expect(moved.claim.status).toBe("verified");

    const old = await d.accounts.getClaim(TEST_ACCOUNT.userId, first.id);
    expect(old).toMatchObject({ status: "superseded", supersededAt: "2026-11-25T08:30:00.000Z" });
    const view = claimView(old!, d.config);
    expect(view.statusText).toBe("Ownership moved to another account on 25 November 2026.");
    expect(view.statusText).toBe(CLAIMS_TEXT.status.superseded("2026-11-25T08:30:00.000Z"));
    expect(view.canCheck).toBe(false);
    expect(view.canStartOver).toBe(false);
  });

  // Fails if a superseded claim can be verified again by Check again or the daily recheck, even with its record still in place.
  it("a superseded claim is never restored: Check again answers 409 and the recheck skips it", async () => {
    const { d, clock, claim, check, publish, records } = await twoAccounts();
    const first = await claim("first");
    const second = await claim("second");
    publish(first.token);
    await check("first", first.id);
    publish(second.token);
    await check("second", second.id);
    // Both records stay published.
    records.push([`retrofit-site-verification=${first.token}`]);
    const again = await check("first", first.id);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "superseded", message: CLAIMS_TEXT.supersededFinal });
    clock.advance(25 * 3600_000);
    const summary = await recheckDueClaims(d);
    expect(summary).toMatchObject({ checked: 1, verified: 1 });
    expect((await d.accounts.getClaim(TEST_ACCOUNT.userId, first.id))?.status).toBe("superseded");
    expect((await d.accounts.getClaim(OTHER_ACCOUNT.userId, second.id))?.status).toBe("verified");
  });

  // Fails if deleting the account that took the host over restores the earlier claim.
  it("deleting the new holder's account keeps the earlier claim superseded", async () => {
    const { d, claim, check, publish } = await twoAccounts();
    const first = await claim("first");
    const second = await claim("second");
    publish(first.token);
    await check("first", first.id);
    publish(second.token);
    await check("second", second.id);
    await d.accounts.deleteAccountData(OTHER_ACCOUNT.userId);
    expect((await d.accounts.getClaim(TEST_ACCOUNT.userId, first.id))?.status).toBe("superseded");
  });
});
