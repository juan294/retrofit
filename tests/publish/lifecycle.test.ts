/**
 * One public state (parent success criteria 5 and 6): whatever ends it (a lapse, a transfer, removing the
 * claim, unpublishing, account deletion) ends the page, every file, the badge and the sitemap entry at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountData } from "@/lib/accounts/data";
import { AccountDataUnavailable } from "@/lib/accounts/data";
import { deleteAccount } from "@/lib/accounts/delete";
import { readAccountByToken } from "@/lib/accounts/session";
import { handleRemoveClaim } from "@/lib/api/claims";
import { handleUnpublish } from "@/lib/api/publish";
import { handleBadge } from "@/lib/badge/handler";
import { recheckDueClaims } from "@/lib/claims/recheck";
import { handlePublishedFile } from "@/lib/publish/files";
import { readPublishedPage } from "@/lib/publish/page";
import { publishedSitemap, SITEMAP_PUBLISHED_MAX } from "@/lib/publish/sitemap";
import { sha256Hex } from "@/lib/security/tokens";
import { accountCookie, fakeClock, OTHER_ACCOUNT, postRequest, PUBLIC_ORIGIN, testDeps, TEST_ACCOUNT, type TestDeps } from "../helpers/server-deps";
import { HOST, lapseNow, OWNER, publishDirect, publishedFiles, snapshotOf, verifiedClaim, verifyNow } from "./setup";

const DAY = 25 * 3600_000;
const FILES = publishedFiles(HOST).map(([file]) => file);

beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

async function setup() {
  const clock = fakeClock(Date.parse("2026-11-21T10:00:00.000Z"));
  const records: string[][] = [];
  const d = testDeps({ clock: clock.clock, txt: async () => records });
  const claim = await verifiedClaim(d);
  await publishDirect(d, snapshotOf(HOST, "2026-11-20T08:00:00.000Z", "first owner"));
  return { d, clock, claim, records };
}

/** Every public surface of the host: all on, or all off. */
async function visible(d: TestDeps): Promise<"public" | "private"> {
  const page = (await readPublishedPage(d, HOST)) !== null;
  const files = await Promise.all(FILES.map(async (f) => (await handlePublishedFile(d, HOST, f.split("/"))).status));
  const badge = (await handleBadge(d, `${HOST}.svg`)).status;
  const sitemap = (await publishedSitemap(d)).includes(`${PUBLIC_ORIGIN}/s/${HOST}`);
  const all = [page, ...files.map((s) => s === 200), badge === 200, sitemap];
  if (all.every(Boolean)) return "public";
  expect(all, "every surface is off together").toEqual(all.map(() => false));
  for (const s of [...files, badge]) expect(s).toBe(404);
  return "private";
}

describe("what ends and restores the public state", () => {
  // Fails if three failed daily rechecks leave any surface public, or one passing recheck does not restore all of them.
  it("three failed daily rechecks hide the page, every file, the badge and the sitemap entry; one pass restores them", async () => {
    const { d, clock, records } = await setup();
    expect(await visible(d)).toBe("public");
    for (let n = 0; n < 3; n++) {
      expect(await visible(d)).toBe("public");
      clock.advance(DAY);
      await recheckDueClaims(d);
    }
    expect(await visible(d)).toBe("private");
    // The record (the claim's token; only its hash is stored, so the test restarts the check through the adapter).
    const claim = (await d.accounts.listClaims(OWNER))[0]!;
    expect(claim.status).toBe("lapsed");
    records.push(["unrelated"]);
    await verifyNow(d, claim);
    expect(await visible(d)).toBe("public");
    expect((await d.accounts.getPublicSnapshot(HOST))?.snapshot).toMatchObject({ pages: [{ text: "first owner" }] });
  });

  // Fails if removing the claim, unpublishing, or deleting the account leaves any surface public.
  it.each(["remove the claim", "unpublish", "delete the account"])("%s ends every surface at once", async (how) => {
    const { d, claim } = await setup();
    const cookie = await accountCookie(d, TEST_ACCOUNT);
    expect(await visible(d)).toBe("public");
    if (how === "remove the claim") expect((await handleRemoveClaim(postRequest("/api/claims/remove", { claimId: claim.id }, { cookie }), d)).status).toBe(200);
    if (how === "unpublish") expect((await handleUnpublish(postRequest("/api/publish/remove", { host: HOST }, { cookie }), d)).status).toBe(200);
    if (how === "delete the account") {
      const account = await readAccountByToken(cookie.split("=")[1], d);
      const deps = { ...d, auth: { ...d.auth, getUser: async () => null, deleteUser: async () => {} } } as unknown as TestDeps;
      expect(await deleteAccount(deps, account!)).toMatchObject({ stage: "deleted" });
    }
    expect(await visible(d)).toBe("private");
  });

  // Fails if a transfer leaves the old page public, shows it under the new owner, or a later re-claim by the old owner brings it back.
  it("a transfer ends it; the new owner publishes their own; the old owner's re-claim does not bring the old page back", async () => {
    const { d, claim } = await setup();
    const second = await verifiedClaim(d, OTHER_ACCOUNT.userId);
    expect(await visible(d)).toBe("private");
    await publishDirect(d, snapshotOf(HOST, "2026-11-19T08:00:00.000Z", "second owner"), { accountId: OTHER_ACCOUNT.userId });
    expect(await visible(d)).toBe("public");
    expect((await d.accounts.getPublicSnapshot(HOST))?.snapshot).toMatchObject({ pages: [{ text: "second owner" }] });
    await lapseNow(d, second);
    expect(await visible(d)).toBe("private");
    expect(await d.accounts.deleteClaim(OWNER, claim.id)).toBe(true);
    await verifiedClaim(d);
    expect(await visible(d)).toBe("private");
    await publishDirect(d, snapshotOf(HOST, "2026-11-21T08:00:00.000Z", "first owner again"));
    expect(await visible(d)).toBe("public");
  });
});

describe("the public page read", () => {
  // Fails if the page needs a second read, reads the snapshot, or answers for a host in another form.
  it("reads the report once, for the exact host only", async () => {
    const { d } = await setup();
    const calls: string[] = [];
    const accounts = new Proxy(d.accounts, {
      get: (t, name: keyof AccountData) => (...args: unknown[]) => {
        calls.push(name);
        return (t[name] as (...a: unknown[]) => unknown)(...args);
      },
    });
    expect(await readPublishedPage({ accounts }, HOST)).toMatchObject({ host: HOST, fetchedAt: "2026-11-20T08:00:00.000Z", report: { scoreVersion: "score/v1" } });
    expect(calls).toEqual(["getPublicReport"]);
    for (const other of ["SHOP.example.com", `${HOST}.`, `${HOST}:443`, "..", `${sha256Hex("x")}`]) expect(await readPublishedPage({ accounts: d.accounts }, other), other).toBeNull();
  });
});

describe("the sitemap", () => {
  // Fails if the sitemap reads an unbounded number of hosts, or an outage takes the static sitemap down.
  it("asks for a bounded number of hosts and answers none when the account data is unavailable", async () => {
    const { d } = await setup();
    const limits: number[] = [];
    const counting = { ...d.accounts, listPublicHosts: async (n: number) => (limits.push(n), ["a.example", "b.example"]) };
    expect(await publishedSitemap({ ...d, accounts: counting })).toEqual([`${PUBLIC_ORIGIN}/s/a.example`, `${PUBLIC_ORIGIN}/s/b.example`]);
    expect(limits).toEqual([SITEMAP_PUBLISHED_MAX]);
    expect(SITEMAP_PUBLISHED_MAX).toBeLessThanOrEqual(5000);
    const down = { ...d.accounts, listPublicHosts: async () => { throw new AccountDataUnavailable("listPublicHosts", "request_failed"); } };
    expect(await publishedSitemap({ ...d, accounts: down })).toEqual([]);
  });
});
