/**
 * Shared AccountData contract suite. The memory adapter runs it in
 * `tests/accounts/data.memory.test.ts` (unit project); the Supabase adapter runs
 * it in `tests/db/accounts.db.test.ts` on the disposable gate stack.
 *
 * Every email carries a per-test random tag, so runs never collide in a shared
 * database. Two clients over one backing (or one database) model two server
 * instances.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { CLAIM_LAPSE_AFTER, MAX_PENDING_CLAIMS, MAX_SAVED_REPORTS, type AccountData, type Claim, type SaveReportInput, type SavedReportSummary } from "@/lib/accounts/data";
import { sha256Hex } from "@/lib/security/tokens";

export interface AccountDataClients {
  a: AccountData;
  b: AccountData;
  /** Creates an account (a Supabase Auth user on the database) and returns its id. */
  newAccount: () => Promise<string>;
}

const TOKEN = /^[0-9a-f]{32}$/;

export function runAccountDataContract(name: string, makeClients: () => Promise<AccountDataClients>): void {
  describe(`AccountData contract: ${name}`, () => {
    let a: AccountData;
    let b: AccountData;
    let newAccount: () => Promise<string>;
    let tag: string;
    const email = (local: string) => `${local}-${tag}@example.test`;

    beforeEach(async () => {
      ({ a, b, newAccount } = await makeClients());
      tag = randomUUID().slice(0, 8);
    });

    describe("notify signups", () => {
      // Fails if the address is stored as typed (a later signup in another case would be a second row).
      it("stores the email trimmed and in lower case, and the other client finds it in any case", async () => {
        const typed = `  Ana.Smith-${tag.toUpperCase()}@Example.TEST `;
        const r = await a.addNotifySignup(typed, false);
        expect(r.created).toBe(true);
        const stored = await b.findNotifySignup(email("ana.smith"));
        expect(stored?.email).toBe(email("ana.smith"));
        expect((await b.findNotifySignup(typed))?.email).toBe(email("ana.smith"));
      });

      // Fails if consent is true without an explicit tick, or a tick is dropped.
      it("stores marketing consent as false unless it is given, and true when it is", async () => {
        await a.addNotifySignup(email("no-box"));
        await a.addNotifySignup(email("unticked"), false);
        await a.addNotifySignup(email("ticked"), true);
        expect((await b.findNotifySignup(email("no-box")))?.marketingConsent).toBe(false);
        expect((await b.findNotifySignup(email("unticked")))?.marketingConsent).toBe(false);
        expect((await b.findNotifySignup(email("ticked")))?.marketingConsent).toBe(true);
      });

      // Fails if a new signup has no unsubscribe token for its first message, or the token is not 128 random bits in hex.
      it("returns a new unsubscribe token only when the signup is new", async () => {
        const first = await a.addNotifySignup(email("t"), false);
        expect(first.unsubscribeToken).toMatch(TOKEN);
        const repeat = await b.addNotifySignup(email("T"), false);
        expect(repeat).toEqual({ created: false, unsubscribeToken: null });
        const other = await a.addNotifySignup(email("t2"), false);
        expect(other.unsubscribeToken).not.toBe(first.unsubscribeToken);
      });

      // Fails if a repeat signup (for example a third party ticking the box for someone else's address) changes the stored row.
      it("a repeat signup changes nothing: consent and creation time stay as first stored", async () => {
        await a.addNotifySignup(email("dup"), false);
        const before = await b.findNotifySignup(email("dup"));
        const again = await b.addNotifySignup(email("DUP"), true);
        expect(again.created).toBe(false);
        const after = await a.findNotifySignup(email("dup"));
        expect(after).toEqual(before);
        expect(after?.marketingConsent).toBe(false);
      });

      // Fails if two instances racing on one address both report a new signup (two first messages would go out).
      it("two concurrent signups for one address create one row", async () => {
        const results = await Promise.all([a.addNotifySignup(email("race"), false), b.addNotifySignup(email("Race"), false)]);
        expect(results.filter((r) => r.created)).toHaveLength(1);
      });

      // Fails if an invalid address reaches storage instead of being refused before any write.
      it("refuses an invalid address with RangeError and stores nothing", async () => {
        for (const bad of ["", "no-at-sign", `two@@${tag}.test`, `spaces in@${tag}.test`, `${"x".repeat(250)}@${tag}.test`]) {
          await expect(a.addNotifySignup(bad, false)).rejects.toThrow(RangeError);
        }
        expect(await b.findNotifySignup(`two@@${tag}.test`)).toBeNull();
      });

      // Fails if an unknown address is reported as stored.
      it("findNotifySignup answers null for an unknown or invalid address", async () => {
        expect(await a.findNotifySignup(email("never"))).toBeNull();
        expect(await a.findNotifySignup("not an email")).toBeNull();
      });
    });

    describe("unsubscribe", () => {
      // Fails if the token does not unsubscribe its own row, or the time is not recorded.
      it("unsubscribes once by the token hash and records the time", async () => {
        const { unsubscribeToken } = await a.addNotifySignup(email("u"), true);
        expect(await b.unsubscribe(sha256Hex(unsubscribeToken as string))).toBe("unsubscribed");
        const row = await a.findNotifySignup(email("u"));
        expect(row?.unsubscribedAt).toEqual(expect.any(String));
        expect(Number.isFinite(Date.parse(row?.unsubscribedAt as string))).toBe(true);
      });

      // Fails if a second click moves the recorded time or reports an error.
      it("is idempotent: a second unsubscribe answers already and keeps the first time", async () => {
        const { unsubscribeToken } = await a.addNotifySignup(email("u2"), false);
        const hash = sha256Hex(unsubscribeToken as string);
        await a.unsubscribe(hash);
        const first = (await a.findNotifySignup(email("u2")))?.unsubscribedAt;
        expect(await b.unsubscribe(hash)).toBe("already");
        expect((await b.findNotifySignup(email("u2")))?.unsubscribedAt).toBe(first);
      });

      // Fails if an unknown or malformed hash unsubscribes anything or throws.
      it("answers unknown for a hash that matches no signup, or is not a SHA-256 hex digest", async () => {
        const { unsubscribeToken } = await a.addNotifySignup(email("keep"), false);
        expect(await a.unsubscribe(sha256Hex(`${unsubscribeToken}x`))).toBe("unknown");
        expect(await a.unsubscribe("not-a-hash")).toBe("unknown");
        expect(await a.unsubscribe(unsubscribeToken as string)).toBe("unknown");
        expect((await b.findNotifySignup(email("keep")))?.unsubscribedAt).toBeNull();
      });

      // Fails if a repeat signup re-subscribes an address that unsubscribed (anyone could re-subscribe someone else).
      it("a signup after unsubscribing stays unsubscribed", async () => {
        const { unsubscribeToken } = await a.addNotifySignup(email("back"), false);
        await a.unsubscribe(sha256Hex(unsubscribeToken as string));
        expect((await b.addNotifySignup(email("back"), true)).created).toBe(false);
        const row = await a.findNotifySignup(email("back"));
        expect(row?.unsubscribedAt).not.toBeNull();
        expect(row?.marketingConsent).toBe(false);
      });
    });

    /** Saves and returns the stored summary (the save must create or find a row). */
    const saved = async (data: AccountData, id: string, input: SaveReportInput): Promise<SavedReportSummary> => {
      const r = await data.saveReport(id, input);
      if (r.outcome === "full") throw new Error("unexpected full");
      return r.report;
    };
    const report = (score: number | null, host: string) => ({ status: "ready", scoreVersion: "score/v1", host, score, summary: "s", webmcp: "none", fetchedAt: "2026-11-23T10:00:00.000Z", checks: [{ id: "disc.robots", result: "pass" }] });

    describe("profiles", () => {
      // Fails if a repeat sign-in fails or moves the creation time (ensureProfile runs on every sign-in).
      it("ensureProfile creates the profile once and keeps its creation time", async () => {
        const id = await newAccount();
        expect(await b.getProfile(id)).toBeNull();
        await a.ensureProfile(id);
        const first = await b.getProfile(id);
        expect(Number.isFinite(Date.parse(first?.createdAt as string))).toBe(true);
        await b.ensureProfile(id);
        expect(await a.getProfile(id)).toEqual(first);
      });

      // Fails if an account id that is not a UUID reaches storage.
      it("refuses an account id that is not a UUID", async () => {
        await expect(a.ensureProfile("not-a-uuid")).rejects.toThrow(RangeError);
        expect(await a.getProfile("not-a-uuid")).toBeNull();
      });
    });

    describe("saved reports", () => {
      // Fails if a saved report is not readable by its account from another instance, or loses its host, score or fetch time.
      it("saves a report and lists it newest first with its host, score and fetch time", async () => {
        const id = await newAccount();
        const first = await saved(a, id, { host: "one.example", report: report(40, "one.example"), fetchedAt: "2026-11-20T08:00:00.000Z" });
        const second = await saved(a, id, { host: "two.example", report: report(null, "two.example"), fetchedAt: "2026-11-21T08:00:00.000Z" });
        const list = await b.listSavedReports(id);
        expect(list.map((r) => r.id)).toEqual([second.id, first.id]);
        expect(list[1]).toEqual({ id: first.id, host: "one.example", score: 40, fetchedAt: "2026-11-20T08:00:00.000Z", savedAt: first.savedAt });
        expect(list[0]?.score).toBeNull();
        expect(Number.isFinite(Date.parse(first.savedAt))).toBe(true);
      });

      // Fails if the full report is not kept as saved, or another account can open it.
      it("getSavedReport returns the whole report to its account only", async () => {
        const owner = await newAccount();
        const other = await newAccount();
        const kept = await saved(a, owner, { host: "three.example", report: report(77, "three.example"), fetchedAt: "2026-11-22T08:00:00.000Z" });
        const read = await b.getSavedReport(owner, kept.id);
        expect(read?.report).toEqual(report(77, "three.example"));
        expect(read?.host).toBe("three.example");
        expect(await b.getSavedReport(other, kept.id)).toBeNull();
        expect(await b.listSavedReports(other)).toEqual([]);
      });

      // P2-R5. Fails if saving the same report twice (two clicks, two tabs, two instances) stores it twice.
      it("saving the same host and fetch time again answers existing with the first id, also when two saves race", async () => {
        const id = await newAccount();
        const input = { host: "same.example", report: report(10, "same.example"), fetchedAt: "2026-11-22T08:00:00.000Z" };
        const first = await a.saveReport(id, input);
        expect(first.outcome).toBe("created");
        const again = await b.saveReport(id, { ...input, fetchedAt: "2026-11-22T08:00:00Z" });
        expect(again).toEqual({ outcome: "existing", report: first.outcome === "full" ? null : first.report });
        const raced = await Promise.all([a.saveReport(id, { ...input, host: "race.example" }), b.saveReport(id, { ...input, host: "race.example" })]);
        expect(raced.map((r) => r.outcome).sort()).toEqual(["created", "existing"]);
        expect(await a.listSavedReports(id)).toHaveLength(2);
        // Another account saving the same report gets its own copy.
        expect((await a.saveReport(await newAccount(), input)).outcome).toBe("created");
      });

      // P2-R5. Fails if an account can store more than MAX_SAVED_REPORTS reports, or a duplicate is refused as full.
      it(`keeps at most ${MAX_SAVED_REPORTS} reports per account and answers full past that`, async () => {
        const id = await newAccount();
        const at = (n: number) => new Date(Date.UTC(2026, 10, 1) + n * 60_000).toISOString();
        for (let n = 0; n < MAX_SAVED_REPORTS; n++) expect((await a.saveReport(id, { host: "cap.example", report: report(n, "cap.example"), fetchedAt: at(n) })).outcome).toBe("created");
        expect(await b.saveReport(id, { host: "cap.example", report: report(1, "cap.example"), fetchedAt: at(MAX_SAVED_REPORTS) })).toEqual({ outcome: "full" });
        expect((await b.saveReport(id, { host: "cap.example", report: report(0, "cap.example"), fetchedAt: at(0) })).outcome).toBe("existing");
        expect(await a.listSavedReports(id)).toHaveLength(MAX_SAVED_REPORTS);
      }, 60_000);

      // Fails if a malformed or unknown report id throws or reveals anything.
      it("getSavedReport answers null for an unknown or malformed id", async () => {
        const id = await newAccount();
        expect(await a.getSavedReport(id, "00000000-0000-4000-8000-000000000000")).toBeNull();
        expect(await a.getSavedReport(id, "../etc")).toBeNull();
      });

      // Fails if an invalid save reaches storage (a report must be an object with a host and an ISO fetch time).
      it("refuses an invalid account id, host, report or fetch time with RangeError", async () => {
        const id = await newAccount();
        const ok = { host: "h.example", report: report(1, "h.example"), fetchedAt: "2026-11-22T08:00:00.000Z" };
        await expect(a.saveReport("nope", ok)).rejects.toThrow(RangeError);
        await expect(a.saveReport(id, { ...ok, host: "" })).rejects.toThrow(RangeError);
        await expect(a.saveReport(id, { ...ok, report: [] as unknown as Record<string, unknown> })).rejects.toThrow(RangeError);
        await expect(a.saveReport(id, { ...ok, fetchedAt: "yesterday" })).rejects.toThrow(RangeError);
        expect(await b.listSavedReports(id)).toEqual([]);
      });
    });

    describe("ownership claims", () => {
      const host = (label: string) => `${label}-${tag}.example.test`;
      const hash = (n: string) => sha256Hex(`${tag}-${n}`);
      /** Creates a claim and returns it (the create must succeed). */
      const claimed = async (data: AccountData, accountId: string, label: string, method: "meta" | "dns" = "meta", token = label): Promise<Claim> => {
        const r = await data.createClaim(accountId, { host: host(label), method, tokenHash: hash(token) });
        if (r.outcome !== "created") throw new Error(`unexpected ${r.outcome}`);
        return r.claim;
      };
      const verified = async (data: AccountData, claim: Claim, at: string) => {
        const r = await data.verifyClaim(claim.id, { tokenHash: claim.tokenHash, checkedAt: at });
        if (r.outcome !== "verified") throw new Error(`unexpected ${r.outcome}`);
        return r;
      };
      const fail = (data: AccountData, claim: Claim, at: string) => data.recordClaimFailure(claim.id, { tokenHash: claim.tokenHash, result: "tag_missing", detail: null, checkedAt: at });

      // Fails if a new claim is not pending with no check, is unreadable from another instance, or readable by another account.
      it("createClaim stores a pending claim with its host, method and token hash, readable by its account only", async () => {
        const owner = await newAccount();
        const other = await newAccount();
        const c = await claimed(a, owner, "new", "dns");
        expect(c).toMatchObject({ accountId: owner, host: host("new"), method: "dns", tokenHash: hash("new"), status: "pending", verifiedAt: null, lastCheckedAt: null, failures: 0, supersededAt: null, lastResult: null, lastDetail: null });
        expect(Number.isFinite(Date.parse(c.createdAt))).toBe(true);
        expect(await b.getClaim(owner, c.id)).toEqual(c);
        expect(await b.listClaims(owner)).toEqual([c]);
        expect(await b.getClaim(other, c.id)).toBeNull();
        expect(await b.listClaims(other)).toEqual([]);
        expect(await b.getClaim(owner, "not-a-uuid")).toBeNull();
      });

      // Fails if one account can hold two claims for one host (also when two instances race), or two accounts cannot each hold one.
      it("one claim per account and host: a repeat answers exists, also when two creates race; another account gets its own", async () => {
        const owner = await newAccount();
        const first = await claimed(a, owner, "dup");
        const again = await b.createClaim(owner, { host: host("dup"), method: "dns", tokenHash: hash("other") });
        expect(again).toEqual({ outcome: "exists", claim: first });
        const raced = await Promise.all([a.createClaim(owner, { host: host("race"), method: "meta", tokenHash: hash("r1") }), b.createClaim(owner, { host: host("race"), method: "meta", tokenHash: hash("r2") })]);
        expect(raced.map((r) => r.outcome).sort()).toEqual(["created", "exists"]);
        expect((await a.createClaim(await newAccount(), { host: host("dup"), method: "meta", tokenHash: hash("x") })).outcome).toBe("created");
      });

      // Fails if an account can hold more than MAX_PENDING_CLAIMS pending claims, or a verified claim counts against the limit.
      it(`keeps at most ${MAX_PENDING_CLAIMS} pending claims per account`, async () => {
        const owner = await newAccount();
        const claims: Claim[] = [];
        for (let n = 0; n < MAX_PENDING_CLAIMS; n++) claims.push(await claimed(a, owner, `cap${n}`));
        expect(await b.createClaim(owner, { host: host("cap-over"), method: "meta", tokenHash: hash("o") })).toEqual({ outcome: "full" });
        await verified(a, claims[0]!, "2026-11-23T10:00:00.000Z");
        expect((await b.createClaim(owner, { host: host("cap-over"), method: "meta", tokenHash: hash("o") })).outcome).toBe("created");
      }, 60_000);

      // Fails if Start over keeps the old token, method or check result, works on a verified or superseded claim, or on another account's.
      it("restartClaim gives a pending or lapsed claim a new token and method with no check result; verified, superseded and other accounts are refused", async () => {
        const owner = await newAccount();
        const c = await claimed(a, owner, "restart");
        await fail(a, c, "2026-11-23T10:00:00.000Z");
        const r = await b.restartClaim(owner, c.id, { method: "dns", tokenHash: hash("new-token") });
        expect(r.outcome).toBe("restarted");
        expect(r.outcome === "restarted" && r.claim).toMatchObject({ id: c.id, method: "dns", tokenHash: hash("new-token"), status: "pending", failures: 0, lastCheckedAt: null, lastResult: null, verifiedAt: null });
        expect(await a.restartClaim(await newAccount(), c.id, { method: "meta", tokenHash: hash("x") })).toEqual({ outcome: "missing" });

        const v = await verified(a, (await a.getClaim(owner, c.id))!, "2026-11-23T11:00:00.000Z");
        expect((await b.restartClaim(owner, c.id, { method: "meta", tokenHash: hash("y") })).outcome).toBe("verified");
        expect((await a.getClaim(owner, c.id))?.tokenHash).toBe(v.claim.tokenHash);
        for (let n = 0; n < CLAIM_LAPSE_AFTER; n++) await fail(a, v.claim, `2026-11-2${4 + n}T10:00:00.000Z`);
        expect((await a.getClaim(owner, c.id))?.status).toBe("lapsed");
        expect((await b.restartClaim(owner, c.id, { method: "meta", tokenHash: hash("z") })).outcome).toBe("restarted");
      });

      // Fails if a failed check is not recorded, a pending claim lapses, or a verified claim lapses before CLAIM_LAPSE_AFTER failures.
      it(`recordClaimFailure counts consecutive failures; ${CLAIM_LAPSE_AFTER} lapse a verified claim, a pending claim stays pending`, async () => {
        const owner = await newAccount();
        const pending = await claimed(a, owner, "fail-pending");
        for (let n = 0; n < CLAIM_LAPSE_AFTER + 1; n++) await fail(b, pending, "2026-11-23T10:00:00.000Z");
        expect(await a.getClaim(owner, pending.id)).toMatchObject({ status: "pending", failures: CLAIM_LAPSE_AFTER + 1, lastResult: "tag_missing", lastCheckedAt: "2026-11-23T10:00:00.000Z" });

        const c = (await verified(a, await claimed(a, owner, "fail-verified"), "2026-11-23T09:00:00.000Z")).claim;
        for (let n = 1; n < CLAIM_LAPSE_AFTER; n++) {
          const r = await b.recordClaimFailure(c.id, { tokenHash: c.tokenHash, result: "http_status", detail: 503, checkedAt: `2026-11-2${3 + n}T10:00:00.000Z` });
          expect(r.outcome === "updated" && r.claim).toMatchObject({ status: "verified", failures: n, lastResult: "http_status", lastDetail: 503 });
        }
        const lapsed = await b.recordClaimFailure(c.id, { tokenHash: c.tokenHash, result: "record_missing", detail: null, checkedAt: "2026-11-30T10:00:00.000Z" });
        expect(lapsed.outcome === "updated" && lapsed.claim).toMatchObject({ status: "lapsed", failures: CLAIM_LAPSE_AFTER, lastCheckedAt: "2026-11-30T10:00:00.000Z", verifiedAt: "2026-11-23T09:00:00.000Z" });
      });

      // Fails if a check result is applied after Start over replaced the token it checked, or for an unknown claim.
      it("a check against a replaced token is stale and changes nothing; an unknown claim is missing", async () => {
        const owner = await newAccount();
        const c = await claimed(a, owner, "stale");
        await a.restartClaim(owner, c.id, { method: "meta", tokenHash: hash("rotated") });
        expect((await b.recordClaimFailure(c.id, { tokenHash: c.tokenHash, result: "tag_missing", detail: null, checkedAt: "2026-11-23T10:00:00.000Z" })).outcome).toBe("stale");
        expect((await b.verifyClaim(c.id, { tokenHash: c.tokenHash, checkedAt: "2026-11-23T10:00:00.000Z" })).outcome).toBe("stale");
        expect(await a.getClaim(owner, c.id)).toMatchObject({ status: "pending", failures: 0, lastCheckedAt: null });
        const unknown = "00000000-0000-4000-8000-00000000ffff";
        expect(await a.verifyClaim(unknown, { tokenHash: c.tokenHash, checkedAt: "2026-11-23T10:00:00.000Z" })).toEqual({ outcome: "missing" });
        expect(await a.recordClaimFailure(unknown, { tokenHash: c.tokenHash, result: "tag_missing", detail: null, checkedAt: "2026-11-23T10:00:00.000Z" })).toEqual({ outcome: "missing" });
      });

      // Fails if a pass does not verify (or restore a lapsed claim), keep the first verification time on a recheck, or reset failures.
      it("verifyClaim verifies, resets failures, keeps verifiedAt on a recheck and restores a lapsed claim", async () => {
        const owner = await newAccount();
        const c = await claimed(a, owner, "verify");
        await fail(a, c, "2026-11-23T08:00:00.000Z");
        const first = await verified(b, c, "2026-11-23T09:00:00.000Z");
        expect(first.claim).toMatchObject({ status: "verified", verifiedAt: "2026-11-23T09:00:00.000Z", lastCheckedAt: "2026-11-23T09:00:00.000Z", failures: 0, lastResult: "verified", lastDetail: null });
        expect(first.movedFrom).toEqual([]);
        expect((await verified(a, c, "2026-11-24T09:00:00.000Z")).claim.verifiedAt).toBe("2026-11-23T09:00:00.000Z");
        for (let n = 0; n < CLAIM_LAPSE_AFTER; n++) await fail(a, c, `2026-11-2${5 + n}T09:00:00.000Z`);
        const restored = await verified(b, c, "2026-11-29T09:00:00.000Z");
        expect(restored.claim).toMatchObject({ status: "verified", verifiedAt: "2026-11-29T09:00:00.000Z", failures: 0 });
      });

      // Fails if a second account's verification does not move the host, record the change, or a superseded claim can come back.
      it("a second account's verification supersedes the first account's verified or lapsed claim, and a superseded claim is terminal", async () => {
        const first = await newAccount();
        const second = await newAccount();
        const third = await newAccount();
        const old = (await verified(a, await claimed(a, first, "move"), "2026-11-23T09:00:00.000Z")).claim;
        const mine = await claimed(b, second, "move", "dns", "second");
        const moved = await verified(b, mine, "2026-11-24T09:00:00.000Z");
        expect(moved.movedFrom).toEqual([first]);
        expect(await a.getClaim(first, old.id)).toMatchObject({ status: "superseded", supersededAt: "2026-11-24T09:00:00.000Z" });
        expect(await a.getClaim(second, mine.id)).toMatchObject({ status: "verified" });
        // The superseded claim is never verified, failed or restarted again.
        expect((await a.verifyClaim(old.id, { tokenHash: old.tokenHash, checkedAt: "2026-11-25T09:00:00.000Z" })).outcome).toBe("superseded");
        expect((await a.recordClaimFailure(old.id, { tokenHash: old.tokenHash, result: "tag_missing", detail: null, checkedAt: "2026-11-25T09:00:00.000Z" })).outcome).toBe("superseded");
        expect((await a.restartClaim(first, old.id, { method: "meta", tokenHash: hash("again") })).outcome).toBe("superseded");
        expect(await b.getClaim(first, old.id)).toMatchObject({ status: "superseded", supersededAt: "2026-11-24T09:00:00.000Z", lastCheckedAt: "2026-11-23T09:00:00.000Z" });

        // A lapsed holder is superseded too; a pending claim of another account stays pending.
        for (let n = 0; n < CLAIM_LAPSE_AFTER; n++) await fail(a, mine, `2026-11-2${5 + n}T09:00:00.000Z`);
        const waiting = await claimed(a, await newAccount(), "move", "meta", "waiting");
        const byThird = await verified(a, await claimed(a, third, "move", "meta", "third"), "2026-11-29T09:00:00.000Z");
        expect(byThird.movedFrom).toEqual([second]);
        expect(await b.getClaim(second, mine.id)).toMatchObject({ status: "superseded", supersededAt: "2026-11-29T09:00:00.000Z" });
        expect((await b.listClaims(waiting.accountId))[0]?.status).toBe("pending");
      });

      // Fails if two instances verifying one host for two accounts at once both end verified (or the second errors).
      it("two concurrent verifications of one host leave exactly one verified claim", async () => {
        const x = await claimed(a, await newAccount(), "both", "meta", "x");
        const y = await claimed(b, await newAccount(), "both", "meta", "y");
        const results = await Promise.all([a.verifyClaim(x.id, { tokenHash: x.tokenHash, checkedAt: "2026-11-23T09:00:00.000Z" }), b.verifyClaim(y.id, { tokenHash: y.tokenHash, checkedAt: "2026-11-23T09:00:00.000Z" })]);
        expect(results.map((r) => r.outcome)).toEqual(["verified", "verified"]);
        const states = [(await a.getClaim(x.accountId, x.id))?.status, (await a.getClaim(y.accountId, y.id))?.status].sort();
        expect(states).toEqual(["superseded", "verified"]);
      });

      // Fails if the recheck list includes pending or superseded claims, recent checks, misses lapsed ones, or ignores the order or limit.
      it("listClaimsDueForRecheck lists verified and lapsed claims checked before the cutoff, least recently checked first, up to the limit", async () => {
        const owner = await newAccount();
        // Only this case checks claims in 2001, so other cases' claims are never due here.
        const at = (day: number) => `2001-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;
        const v1 = (await verified(a, await claimed(a, owner, "due1"), at(3))).claim;
        const v2 = (await verified(a, await claimed(a, owner, "due2"), at(2))).claim;
        const lapsedClaim = (await verified(a, await claimed(a, owner, "due3"), at(1))).claim;
        for (let n = 0; n < CLAIM_LAPSE_AFTER; n++) await fail(a, lapsedClaim, at(4 + n));
        await claimed(a, owner, "due-pending");
        const recent = (await verified(a, await claimed(a, owner, "due-recent"), at(20))).claim;
        const mine = (list: Claim[]) => list.filter((c) => c.accountId === owner).map((c) => c.id);
        expect(mine(await b.listClaimsDueForRecheck(at(10), 50))).toEqual([v2.id, v1.id, lapsedClaim.id]);
        expect(mine(await b.listClaimsDueForRecheck(at(10), 50))).not.toContain(recent.id);
        const capped = await b.listClaimsDueForRecheck(at(10), 2);
        expect(capped.length).toBeLessThanOrEqual(2);
      });

      // Fails if a claim can be withdrawn by another account, or withdrawing leaves it.
      it("deleteClaim withdraws the account's own claim only", async () => {
        const owner = await newAccount();
        const c = await claimed(a, owner, "withdraw");
        expect(await b.deleteClaim(await newAccount(), c.id)).toBe(false);
        expect(await b.deleteClaim(owner, c.id)).toBe(true);
        expect(await a.getClaim(owner, c.id)).toBeNull();
        expect(await a.deleteClaim(owner, c.id)).toBe(false);
        expect(await a.deleteClaim(owner, "nope")).toBe(false);
      });

      // Fails if invalid claim input reaches storage.
      it("refuses an invalid account id, host, method or token hash with RangeError", async () => {
        const owner = await newAccount();
        const ok = { host: host("ok"), method: "meta" as const, tokenHash: hash("ok") };
        await expect(a.createClaim("nope", ok)).rejects.toThrow(RangeError);
        await expect(a.createClaim(owner, { ...ok, host: "Upper.Example" })).rejects.toThrow(RangeError);
        await expect(a.createClaim(owner, { ...ok, host: "a/b.example" })).rejects.toThrow(RangeError);
        await expect(a.createClaim(owner, { ...ok, method: "email" as "meta" })).rejects.toThrow(RangeError);
        await expect(a.createClaim(owner, { ...ok, tokenHash: "raw-token" })).rejects.toThrow(RangeError);
        expect(await b.listClaims(owner)).toEqual([]);
      });
    });

    describe("account deletion", () => {
      // Fails if deleting one account's data leaves its profile or saved reports, touches another account's, or fails on a retry.
      it("deleteAccountData removes the account's profile and saved reports only, and a second call succeeds", async () => {
        const gone = await newAccount();
        const kept = await newAccount();
        for (const id of [gone, kept]) {
          await a.ensureProfile(id);
          await saved(a, id, { host: "d.example", report: report(5, "d.example"), fetchedAt: "2026-11-22T08:00:00.000Z" });
        }
        await b.deleteAccountData(gone);
        expect(await a.getProfile(gone)).toBeNull();
        expect(await a.listSavedReports(gone)).toEqual([]);
        expect(await a.getProfile(kept)).not.toBeNull();
        expect(await a.listSavedReports(kept)).toHaveLength(1);
        await b.deleteAccountData(gone);
      });

      // Phase 3. Fails if account deletion leaves the account's claims, or touches another account's claim it superseded.
      it("deleteAccountData removes the account's claims and keeps the claims of others, including one it superseded", async () => {
        const gone = await newAccount();
        const kept = await newAccount();
        const host = `del-${tag}.example.test`;
        const keptClaim = await a.createClaim(kept, { host, method: "meta", tokenHash: sha256Hex(`${tag}-k`) });
        if (keptClaim.outcome !== "created") throw new Error("create failed");
        await a.verifyClaim(keptClaim.claim.id, { tokenHash: keptClaim.claim.tokenHash, checkedAt: "2026-11-23T09:00:00.000Z" });
        const goneClaim = await a.createClaim(gone, { host, method: "dns", tokenHash: sha256Hex(`${tag}-g`) });
        if (goneClaim.outcome !== "created") throw new Error("create failed");
        await a.verifyClaim(goneClaim.claim.id, { tokenHash: goneClaim.claim.tokenHash, checkedAt: "2026-11-24T09:00:00.000Z" });
        await b.deleteAccountData(gone);
        expect(await a.listClaims(gone)).toEqual([]);
        expect(await a.getClaim(kept, keptClaim.claim.id)).toMatchObject({ status: "superseded", supersededAt: "2026-11-24T09:00:00.000Z" });
      });
    });
  });
}
