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
import {
  CLAIM_LAPSE_AFTER,
  MAX_API_KEYS,
  MAX_PENDING_CLAIMS,
  MAX_PUBLISHED_SNAPSHOT_BYTES,
  MAX_REPORT_BYTES,
  MAX_SAVED_REPORTS,
  type AccountData,
  type Claim,
  type PublishedSite,
  type PublishSiteInput,
  type SaveReportInput,
  type SavedReportSummary,
} from "@/lib/accounts/data";
import type { BillingState } from "@/lib/billing/state";
import { sha256Hex } from "@/lib/security/tokens";
import type { AgentSnapshot } from "@/lib/snapshot/types";
import { storedSnapshotOf } from "../helpers/agent-snapshot";

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

      // Fails if the host-only read (claim sources) answers another account's report, or differs from the report's host.
      it("getSavedReportHost answers the report's host to its account only", async () => {
        const owner = await newAccount();
        const kept = await saved(a, owner, { host: "host-only.example", report: report(3, "host-only.example"), fetchedAt: "2026-11-22T08:00:00.000Z" });
        expect(await b.getSavedReportHost(owner, kept.id)).toBe("host-only.example");
        expect(await b.getSavedReportHost(await newAccount(), kept.id)).toBeNull();
        expect(await b.getSavedReportHost(owner, "00000000-0000-4000-8000-000000000000")).toBeNull();
        expect(await b.getSavedReportHost(owner, "../etc")).toBeNull();
      });

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
      // Fails if a new claim is not pending with no check, is unreadable from another instance, or readable by another account.
      it("createClaim stores a pending claim with its host, method and token hash, readable by its account only", async () => {
        const owner = await newAccount();
        const other = await newAccount();
        const c = await claimed(a, owner, "new", "dns");
        expect(c).toMatchObject({ accountId: owner, host: host("new"), method: "dns", tokenHash: hash("new"), status: "pending", verifiedAt: null, lastCheckedAt: null, failures: 0, supersededAt: null, lapsedAt: null, lastResult: null, lastDetail: null });
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
        const restarted = await b.restartClaim(owner, c.id, { method: "meta", tokenHash: hash("z") });
        expect(restarted.outcome === "restarted" && restarted.claim).toMatchObject({ status: "pending", lapsedAt: null });
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
        expect(lapsed.outcome === "updated" && lapsed.claim).toMatchObject({ status: "lapsed", failures: CLAIM_LAPSE_AFTER, lastCheckedAt: "2026-11-30T10:00:00.000Z", verifiedAt: "2026-11-23T09:00:00.000Z", lapsedAt: "2026-11-30T10:00:00.000Z" });
        // P3-R8. A later failure keeps the instant the claim lapsed.
        const later = await a.recordClaimFailure(c.id, { tokenHash: c.tokenHash, result: "tag_missing", detail: null, checkedAt: "2026-12-01T10:00:00.000Z" });
        expect(later.outcome === "updated" && later.claim).toMatchObject({ status: "lapsed", lastCheckedAt: "2026-12-01T10:00:00.000Z", lapsedAt: "2026-11-30T10:00:00.000Z" });
        expect((await b.getClaim(owner, pending.id))?.lapsedAt).toBeNull();
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
        expect(restored.claim).toMatchObject({ status: "verified", verifiedAt: "2026-11-29T09:00:00.000Z", failures: 0, lapsedAt: null });
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
      // P3-R4. Fails if a lapsed claim is listed before a verified one, a recent check is listed, or the limit is ignored.
      it("listClaimsDueForRecheck lists claims checked over a day before now: verified first, then lapsed, each least recently checked first", async () => {
        const owner = await newAccount();
        // Only this case checks claims in 2001, so other cases' claims are never due here.
        const at = (day: number) => `2001-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;
        const lapsedClaim = (await verified(a, await claimed(a, owner, "due3"), at(1))).claim;
        for (let n = 0; n < CLAIM_LAPSE_AFTER; n++) await fail(a, lapsedClaim, at(4 + n));
        const v1 = (await verified(a, await claimed(a, owner, "due1"), at(8))).claim;
        const v2 = (await verified(a, await claimed(a, owner, "due2"), at(7))).claim;
        await claimed(a, owner, "due-pending");
        const recent = (await verified(a, await claimed(a, owner, "due-recent"), at(10))).claim;
        const mine = (list: Claim[]) => list.filter((c) => c.accountId === owner).map((c) => c.id);
        expect(mine(await b.listClaimsDueForRecheck(at(11), 50))).toEqual([v2.id, v1.id, lapsedClaim.id]);
        expect(mine(await b.listClaimsDueForRecheck(at(11), 50))).not.toContain(recent.id);
        const capped = await b.listClaimsDueForRecheck(at(11), 2);
        expect(capped.length).toBeLessThanOrEqual(2);
      });

      // P3-R4. Fails if a claim lapsed over 30 days ago is rechecked more than weekly, or never again.
      it("a claim lapsed over 30 days ago is due only when its last check is over 7 days old", async () => {
        const owner = await newAccount();
        // Only this case checks claims in 2002.
        const c = (await verified(a, await claimed(a, owner, "slow"), "2002-01-01T00:00:00.000Z")).claim;
        for (let n = 0; n < CLAIM_LAPSE_AFTER; n++) await fail(a, c, `2002-01-0${2 + n}T00:00:00.000Z`);
        const due = async (now: string) => (await b.listClaimsDueForRecheck(now, 50)).some((x) => x.id === c.id);
        // Lapsed 4 January; on 20 January the lapse is recent, so a check over a day old is due.
        expect(await due("2002-01-20T00:00:00.000Z")).toBe(true);
        await fail(a, c, "2002-02-25T00:00:00.000Z");
        expect(await due("2002-03-01T00:00:00.000Z")).toBe(false);
        expect(await due("2002-03-04T12:00:00.000Z")).toBe(true);
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

    // Phase 4. Public means exactly: a publication row whose claim is verified now and belongs to the row's account.
    describe("published sites", () => {
      const at = (day: number, hour = 9) => `2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
      const lapse = async (data: AccountData, c: Claim, fromDay: number) => {
        for (let n = 0; n < CLAIM_LAPSE_AFTER; n++) await fail(data, c, at(fromDay + n));
        expect((await data.getClaim(c.accountId, c.id))?.status).toBe("lapsed");
      };
      const input = (label: string, text: string, day: number, over: Partial<PublishSiteInput> = {}): PublishSiteInput => ({
        host: host(label),
        snapshot: storedSnapshotOf(host(label), at(day, 8), text),
        report: { scoreVersion: "score/v1", host: host(label), score: 72, fetchedAt: at(day, 8), summary: text },
        fetchedAt: at(day, 8),
        now: at(day, 10),
        ...over,
      });
      const publish = async (data: AccountData, accountId: string, i: PublishSiteInput): Promise<PublishedSite> => {
        const r = await data.publishSite(accountId, i);
        if (!("site" in r)) throw new Error(`unexpected ${r.outcome}`);
        return r.site;
      };
      const marker = async (data: AccountData, label: string) => (await data.getPublicSnapshot(host(label)))?.snapshot.pages[0]?.text ?? null;
      /** Everything a visitor can reach answers null, and the host is not listed. */
      const expectPrivate = async (data: AccountData, label: string) => {
        expect(await data.getPublicSite(host(label))).toBeNull();
        expect(await data.getPublicReport(host(label))).toBeNull();
        expect(await data.getPublicSnapshot(host(label))).toBeNull();
        expect(await data.listPublicHosts(100_000)).not.toContain(host(label));
      };

      // Fails if a site can be published without a claim, with a claim that is not verified, or under another account's claim.
      it("publishSite needs the account's own verified claim for the host", async () => {
        const owner = await newAccount();
        const other = await newAccount();
        expect(await a.publishSite(owner, input("need", "x", 20))).toEqual({ outcome: "no_claim" });
        const c = await claimed(a, owner, "need");
        expect(await b.publishSite(owner, input("need", "x", 20))).toEqual({ outcome: "not_verified" });
        await verified(a, c, at(20));
        expect(await b.publishSite(other, input("need", "x", 20))).toEqual({ outcome: "no_claim" });
        await claimed(a, other, "need");
        expect(await b.publishSite(other, input("need", "x", 20))).toEqual({ outcome: "not_verified" });
        await expectPrivate(a, "need");
        expect(await a.listPublishedSites(owner)).toEqual([]);
      });

      // Fails if a publication is not readable by another instance, the light read carries the snapshot or report, or the list is not the account's own.
      it("a published site is readable whole, as its report and as a light read, and listed for its account only", async () => {
        const owner = await newAccount();
        const c = await claimed(a, owner, "pub");
        await verified(a, c, at(20));
        const r = await a.publishSite(owner, input("pub", "first", 20));
        expect(r.outcome).toBe("published");
        const site = { host: host("pub"), claimId: c.id, score: 72, fetchedAt: at(20, 8), publishedAt: at(20, 10), refreshedAt: at(20, 10), lastRefreshError: null };
        expect("site" in r && r.site).toEqual(site);
        expect(await b.listPublishedSites(owner)).toEqual([site]);
        expect(await b.listPublishedSites(await newAccount())).toEqual([]);
        expect(await b.listPublishedSites("not-a-uuid")).toEqual([]);

        const light = { host: host("pub"), score: 72, fetchedAt: at(20, 8), publishedAt: at(20, 10), refreshedAt: at(20, 10) };
        expect(await b.getPublicSite(host("pub"))).toEqual(light);
        expect(await b.getPublicReport(host("pub"))).toEqual({ ...light, report: input("pub", "first", 20).report });
        expect(await b.getPublicSnapshot(host("pub"))).toEqual({ ...light, snapshot: input("pub", "first", 20).snapshot });
        expect(await b.listPublicHosts(100_000)).toContain(host("pub"));
        expect((await b.listPublicHosts(1)).length).toBeLessThanOrEqual(1);
        expect(await b.listPublicHosts(0)).toEqual([]);
        for (const bad of ["", "PUB.example.test", `${host("pub")}/`, "unknown.example.test"]) expect(await b.getPublicSite(bad)).toBeNull();
      });

      // Fails if a refresh moves the first publication time, keeps an old error, or an analysis that is not newer replaces a newer snapshot.
      it("a newer analysis refreshes the site and clears the last error; the same or an older one is not_newer and changes nothing", async () => {
        const owner = await newAccount();
        await verified(a, await claimed(a, owner, "fresh"), at(20));
        await publish(a, owner, input("fresh", "first", 20));
        expect(await b.recordRefreshError(owner, host("fresh"), "generation_failed")).toMatchObject({ host: host("fresh"), lastRefreshError: "generation_failed" });
        for (const i of [input("fresh", "same", 20), input("fresh", "older", 19)]) expect(await a.publishSite(owner, { ...i, now: at(21) })).toEqual({ outcome: "not_newer", site: (await b.listPublishedSites(owner))[0] });
        expect(await marker(b, "fresh")).toBe("first");
        expect((await b.listPublishedSites(owner))[0]).toMatchObject({ lastRefreshError: "generation_failed", refreshedAt: at(20, 10) });

        const r = await b.publishSite(owner, input("fresh", "second", 22));
        expect(r.outcome).toBe("refreshed");
        expect("site" in r && r.site).toMatchObject({ publishedAt: at(20, 10), refreshedAt: at(22, 10), fetchedAt: at(22, 8), lastRefreshError: null });
        expect(await marker(a, "fresh")).toBe("second");
      });

      // Fails if a failed refresh touches the snapshot, another account can write the error, or anything but a known code is stored.
      it("recordRefreshError stores a known code on the account's own site and keeps the snapshot", async () => {
        const owner = await newAccount();
        await verified(a, await claimed(a, owner, "err"), at(20));
        expect(await a.recordRefreshError(owner, host("err"), "no_analysis")).toBeNull();
        await publish(a, owner, input("err", "kept", 20));
        expect(await b.recordRefreshError(await newAccount(), host("err"), "no_analysis")).toBeNull();
        expect((await a.listPublishedSites(owner))[0]?.lastRefreshError).toBeNull();
        for (const code of ["no_analysis", "generation_failed", "too_large"] as const) {
          const site = await b.recordRefreshError(owner, host("err"), code);
          expect(site?.lastRefreshError).toBe(code);
          expect(await a.listPublishedSites(owner)).toEqual([site]);
        }
        await expect(a.recordRefreshError(owner, host("err"), "<b>page text</b>" as "no_analysis")).rejects.toThrow(RangeError);
        // P4-R1. A refresh without a newer read is not a failed refresh.
        await expect(a.recordRefreshError(owner, host("err"), "not_newer" as "no_analysis")).rejects.toThrow(RangeError);
        expect((await b.listPublishedSites(owner))[0]?.lastRefreshError).toBe("too_large");
        expect(await marker(a, "err")).toBe("kept");
      });

      // Fails if a lapsed or restarted (pending) claim leaves the site public, or a recovered claim does not restore the same publication.
      it("a lapse or Start over hides the site at once, and a passing check makes the same publication public again", async () => {
        const owner = await newAccount();
        const c = await claimed(a, owner, "lapse");
        await verified(a, c, at(10));
        await publish(a, owner, input("lapse", "kept", 10));
        await lapse(b, c, 11);
        await expectPrivate(a, "lapse");
        expect((await a.listPublishedSites(owner)).map((s) => s.host)).toEqual([host("lapse")]);
        expect(await a.publishSite(owner, input("lapse", "while lapsed", 14))).toEqual({ outcome: "not_verified" });
        await verified(b, c, at(15));
        expect(await marker(a, "lapse")).toBe("kept");
        expect(await a.getPublicSite(host("lapse"))).toMatchObject({ publishedAt: at(10, 10) });

        await lapse(a, c, 16);
        const restarted = await b.restartClaim(owner, c.id, { method: "dns", tokenHash: hash("lapse-2") });
        if (restarted.outcome !== "restarted") throw new Error(restarted.outcome);
        await expectPrivate(a, "lapse");
        await verified(a, restarted.claim, at(20));
        expect(await marker(b, "lapse")).toBe("kept");
      });

      // Fails if a transfer leaves the old owner's publication public (also under the new owner's claim), or a later re-claim by the old owner
      // brings it back without publishing again.
      it("a transfer ends the old owner's publication for good, also when the new owner loses the host and the old owner verifies a new claim", async () => {
        const first = await newAccount();
        const second = await newAccount();
        const old = await claimed(a, first, "move");
        await verified(a, old, at(10));
        await publish(a, first, input("move", "first owner", 10));
        const mine = await claimed(b, second, "move");
        await verified(b, mine, at(11));
        await expectPrivate(a, "move");
        expect(await a.listPublishedSites(first)).toEqual([]);
        expect(await a.publishSite(first, input("move", "again", 12))).toEqual({ outcome: "not_verified" });
        expect(await b.deleteClaim(second, mine.id)).toBe(true);
        await expectPrivate(a, "move");

        expect(await a.deleteClaim(first, old.id)).toBe(true);
        await verified(a, await claimed(b, first, "move"), at(13));
        await expectPrivate(b, "move");
        await publish(a, first, input("move", "first owner again", 14));
        expect(await marker(b, "move")).toBe("first owner again");
      });

      // Fails if a claim that went pending (lapsed, then Start over) keeps its publication through a transfer: the claim is not superseded then,
      // so a later check of it would make the old snapshot public.
      it("a transfer ends a paused publication whose claim is pending, so a later check of that claim does not bring it back", async () => {
        const first = await newAccount();
        const second = await newAccount();
        const old = await claimed(a, first, "paused");
        await verified(a, old, at(10));
        await publish(a, first, input("paused", "first owner", 10));
        await lapse(a, old, 11);
        const restarted = await a.restartClaim(first, old.id, { method: "meta", tokenHash: hash("paused-2") });
        if (restarted.outcome !== "restarted") throw new Error(restarted.outcome);
        const mine = await claimed(b, second, "paused");
        await verified(b, mine, at(15));
        expect(await b.deleteClaim(second, mine.id)).toBe(true);
        await verified(a, restarted.claim, at(16));
        await expectPrivate(b, "paused");
        expect(await a.listPublishedSites(first)).toEqual([]);
      });

      // Fails if the new owner's publish does not replace the row, or the old owner can still change or remove it.
      it("the new owner's publish replaces the publication; the old owner cannot change or remove it", async () => {
        const first = await newAccount();
        const second = await newAccount();
        await verified(a, await claimed(a, first, "own"), at(20));
        await publish(a, first, input("own", "first owner", 20));
        const mine = await claimed(b, second, "own");
        await verified(b, mine, at(21));
        // An older read of the site than the first owner's: not a refresh, so not_newer does not apply.
        const r = await b.publishSite(second, input("own", "second owner", 19, { now: at(21, 11) }));
        expect(r.outcome).toBe("published");
        expect("site" in r && r.site).toMatchObject({ claimId: mine.id, publishedAt: at(21, 11) });
        expect(await marker(a, "own")).toBe("second owner");
        expect(await a.unpublishSite(first, host("own"))).toBe(false);
        expect(await a.recordRefreshError(first, host("own"), "too_large")).toBeNull();
        expect(await a.listPublishedSites(first)).toEqual([]);
        expect((await a.listPublishedSites(second))[0]?.lastRefreshError).toBeNull();
      });

      // Fails if unpublishing, removing the claim or deleting the account leaves the site public, or touches another account's site.
      it("unpublishing, removing the claim and deleting the account each remove the site and leave other accounts' sites", async () => {
        const kept = await newAccount();
        await verified(a, await claimed(a, kept, "kept"), at(20));
        await publish(a, kept, input("kept", "kept", 20));
        const owner = await newAccount();
        const claims: Record<string, Claim> = {};
        for (const label of ["un", "rm", "del"]) {
          claims[label] = await claimed(a, owner, label);
          await verified(a, claims[label], at(20));
          await publish(a, owner, input(label, label, 20));
        }
        expect(await b.unpublishSite(kept, host("un"))).toBe(false);
        expect(await b.unpublishSite(owner, host("un"))).toBe(true);
        expect(await a.unpublishSite(owner, host("un"))).toBe(false);
        await expectPrivate(a, "un");
        expect((await a.getClaim(owner, claims.un!.id))?.status).toBe("verified");
        expect(await b.deleteClaim(owner, claims.rm!.id)).toBe(true);
        await expectPrivate(a, "rm");
        expect((await a.listPublishedSites(owner)).map((s) => s.host)).toEqual([host("del")]);
        await b.deleteAccountData(owner);
        await expectPrivate(a, "del");
        expect(await marker(a, "kept")).toBe("kept");
        // A removed publication does not come back with a new claim.
        await verified(a, await claimed(b, owner, "rm"), at(22));
        await expectPrivate(b, "rm");
      });

      // Fails if a publish that races another account's verification can leave the old account's snapshot public.
      it("a publish racing another account's verification never leaves the old account's snapshot public", async () => {
        for (let n = 0; n < 5; n++) {
          const label = `race${n}`;
          const first = await newAccount();
          const second = await newAccount();
          await verified(a, await claimed(a, first, label), at(20));
          const mine = await claimed(b, second, label);
          const [published] = await Promise.all([a.publishSite(first, input(label, "first owner", 20)), b.verifyClaim(mine.id, { tokenHash: mine.tokenHash, checkedAt: at(21) })]);
          expect(["published", "not_verified"]).toContain(published.outcome);
          await expectPrivate(a, label);
          expect(await a.listPublishedSites(first)).toEqual([]);
        }
      });

      // Fails if two instances refreshing at once leave the older snapshot.
      it("two concurrent refreshes leave the newer snapshot", async () => {
        const owner = await newAccount();
        await verified(a, await claimed(a, owner, "both"), at(20));
        await publish(a, owner, input("both", "first", 20));
        const results = await Promise.all([a.publishSite(owner, input("both", "newer", 23)), b.publishSite(owner, input("both", "older", 22))]);
        expect(results[0]?.outcome).toBe("refreshed");
        expect(await marker(a, "both")).toBe("newer");
      });

      // Fails if invalid or oversized input reaches storage.
      it("refuses an invalid account id, host, time or object, and an oversized snapshot or report, with RangeError", async () => {
        const owner = await newAccount();
        await verified(a, await claimed(a, owner, "bad"), at(20));
        const ok = input("bad", "x", 20);
        await expect(a.publishSite("nope", ok)).rejects.toThrow(RangeError);
        for (const over of [
          { host: "Upper.Example" },
          { host: "a/b.example" },
          { fetchedAt: "yesterday" },
          { now: "now" },
          { snapshot: [] as unknown as AgentSnapshot },
          { report: null as unknown as Record<string, unknown> },
          { snapshot: { ...ok.snapshot, source: "x".repeat(MAX_PUBLISHED_SNAPSHOT_BYTES) } },
          { report: { pad: "x".repeat(MAX_REPORT_BYTES) } },
        ]) {
          await expect(a.publishSite(owner, { ...ok, ...over }), JSON.stringify(over).slice(0, 80)).rejects.toThrow(RangeError);
        }
        await expectPrivate(b, "bad");
        // The largest snapshot the rule allows is stored.
        const big = { ...ok.snapshot, source: "" };
        big.source = "x".repeat(MAX_PUBLISHED_SNAPSHOT_BYTES - Buffer.byteLength(JSON.stringify(big)));
        expect((await a.publishSite(owner, { ...ok, snapshot: big })).outcome).toBe("published");
      });
    });

    describe("billing", () => {
      const customer = (label: string) => `cus_${label}_${tag}`;
      const pro: BillingState = { plan: "pro", status: "active", currentPeriodEnd: "2027-03-01T00:00:00.000Z", cancelAtPeriodEnd: false, subscriptionId: "sub_1" };
      const none: BillingState = { plan: "free", status: "canceled", currentPeriodEnd: null, cancelAtPeriodEnd: true, subscriptionId: null };
      const AT = "2027-02-01T10:00:00.500Z";
      const BEFORE = "2027-02-01T10:00:00.499Z";
      const AFTER = "2027-02-01T10:00:00.501Z";
      const linked = async (label: string): Promise<string> => {
        const owner = await newAccount();
        expect((await a.linkBillingCustomer(owner, customer(label))).outcome).toBe("linked");
        return owner;
      };
      const event = (id: string) => ({ id: `evt_${id}_${tag}`, type: "customer.subscription.updated" });

      // Fails if a new account has billing state, a linked customer is not free, or either read misses it on another instance.
      it("an account has no billing until its customer is linked; then it is free, found by account and by customer", async () => {
        const owner = await newAccount();
        expect(await a.getBilling(owner)).toBeNull();
        expect(await a.getBillingByCustomer(customer("new"))).toBeNull();
        const r = await a.linkBillingCustomer(owner, customer("new"));
        const record = { accountId: owner, customerId: customer("new"), plan: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionId: null, stateAt: null };
        expect(r).toEqual({ outcome: "linked", billing: record });
        expect(await b.getBilling(owner)).toEqual(record);
        expect(await b.getBillingByCustomer(customer("new"))).toEqual(record);
        expect(await b.getBilling("not-a-uuid")).toBeNull();
      });

      // Fails if one account gets two customers (also when two checkouts race), or one customer belongs to two accounts.
      it("one customer per account and one account per customer, also when two links race", async () => {
        const owner = await newAccount();
        const raced = await Promise.all([a.linkBillingCustomer(owner, customer("r1")), b.linkBillingCustomer(owner, customer("r2"))]);
        expect(raced.map((r) => r.outcome).sort()).toEqual(["existing", "linked"]);
        const ids = raced.map((r) => ("billing" in r ? r.billing.customerId : null));
        expect(ids[0]).toBe(ids[1]);
        expect((await a.linkBillingCustomer(owner, customer("r3"))).outcome).toBe("existing");
        expect(await b.linkBillingCustomer(await newAccount(), ids[0] as string)).toEqual({ outcome: "taken" });
      });

      // Fails if a state is not stored, an older read overwrites a newer one, or an unknown customer gets a row.
      it("applies a state read from Stripe unless a newer read is stored", async () => {
        const owner = await linked("apply");
        expect(await a.applyBillingState(customer("apply"), { ...pro, observedAt: AT })).toMatchObject({ outcome: "applied", billing: { ...pro, accountId: owner, stateAt: AT } });
        expect(await b.applyBillingState(customer("apply"), { ...none, observedAt: BEFORE })).toMatchObject({ outcome: "stale", billing: { plan: "pro", stateAt: AT } });
        expect(await b.getBilling(owner)).toMatchObject({ ...pro, stateAt: AT });
        expect((await b.applyBillingState(customer("apply"), { ...none, observedAt: AT })).outcome).toBe("applied");
        expect(await a.applyBillingState(customer("apply"), { ...pro, observedAt: AFTER })).toMatchObject({ outcome: "applied", billing: { plan: "pro", stateAt: AFTER } });
        expect(await a.applyBillingState(customer("nobody"), { ...pro, observedAt: AT })).toEqual({ outcome: "unknown" });
        expect(await a.getBillingByCustomer(customer("nobody"))).toBeNull();
      });

      // Fails if a replayed event is applied twice, also when two deliveries race.
      it("applies an event once", async () => {
        const owner = await linked("event");
        expect((await a.applyBillingEvent(event("e1"), customer("event"), { ...pro, observedAt: AT })).outcome).toBe("applied");
        expect(await b.applyBillingEvent(event("e1"), customer("event"), { ...none, observedAt: AFTER })).toEqual({ outcome: "duplicate" });
        expect(await b.getBilling(owner)).toMatchObject({ plan: "pro", stateAt: AT });
        const raced = await Promise.all([a, b, a, b].map((d) => d.applyBillingEvent(event("e2"), customer("event"), { ...none, observedAt: AFTER })));
        expect(raced.map((r) => r.outcome).sort()).toEqual(["applied", "duplicate", "duplicate", "duplicate"]);
        expect(await a.getBilling(owner)).toMatchObject({ status: "canceled", stateAt: AFTER });
      });

      // Fails if an event delivered late overwrites newer state, or an event for an unknown customer is recorded as handled
      // (its redelivery after the customer is linked would be lost).
      it("a late event is recorded and not applied; an unknown customer's event is not recorded", async () => {
        const owner = await linked("late");
        await a.applyBillingEvent(event("new"), customer("late"), { ...pro, observedAt: AT });
        expect((await b.applyBillingEvent(event("old"), customer("late"), { ...none, observedAt: BEFORE })).outcome).toBe("stale");
        expect(await b.getBilling(owner)).toMatchObject({ plan: "pro", stateAt: AT });
        expect(await b.applyBillingEvent(event("old"), customer("late"), { ...none, observedAt: AFTER })).toEqual({ outcome: "duplicate" });
        expect(await a.applyBillingEvent(event("early"), customer("unlinked"), { ...pro, observedAt: AT })).toEqual({ outcome: "unknown" });
        await a.linkBillingCustomer(await newAccount(), customer("unlinked"));
        expect((await a.applyBillingEvent(event("early"), customer("unlinked"), { ...pro, observedAt: AT })).outcome).toBe("applied");
      });

      // Fails if an invalid id, plan, status or time reaches storage, or records the event without its state.
      it("refuses an invalid account, customer, event, plan, status or time with RangeError, and records nothing", async () => {
        const owner = await linked("bad");
        await expect(a.linkBillingCustomer("nope", customer("x"))).rejects.toThrow(RangeError);
        for (const id of ["", "cus 1", "sub_1", "x".repeat(300)]) await expect(a.linkBillingCustomer(owner, id), id).rejects.toThrow(RangeError);
        const ok = { ...pro, observedAt: AT };
        for (const bad of [{ plan: "gold" }, { status: "" }, { status: "Active!" }, { currentPeriodEnd: "soon" }, { observedAt: "now" }, { subscriptionId: "not a sub" }]) {
          await expect(a.applyBillingEvent(event("bad"), customer("bad"), { ...ok, ...bad } as typeof ok), JSON.stringify(bad)).rejects.toThrow(RangeError);
          await expect(a.applyBillingState(customer("bad"), { ...ok, ...bad } as typeof ok), JSON.stringify(bad)).rejects.toThrow(RangeError);
        }
        await expect(a.applyBillingEvent({ id: "nope", type: "t" }, customer("bad"), ok)).rejects.toThrow(RangeError);
        expect((await a.applyBillingEvent(event("bad"), customer("bad"), ok)).outcome).toBe("applied");
      });

      // Fails if account deletion leaves the billing row or a key, or touches another account's.
      it("deleteAccountData removes the account's billing and API keys only", async () => {
        const gone = await linked("gone");
        const kept = await linked("kept");
        for (const id of [gone, kept]) await a.createApiKey(id, { keyHash: sha256Hex(`${tag}-${id}`), hint: "beef" });
        await b.deleteAccountData(gone);
        expect(await a.getBilling(gone)).toBeNull();
        expect(await a.getBillingByCustomer(customer("gone"))).toBeNull();
        expect(await a.findApiKeyAccount(sha256Hex(`${tag}-${gone}`))).toBeNull();
        expect(await a.getBilling(kept)).not.toBeNull();
        expect(await a.findApiKeyAccount(sha256Hex(`${tag}-${kept}`))).toBe(kept);
        expect(await a.applyBillingEvent(event("gone"), customer("gone"), { ...pro, observedAt: AT })).toEqual({ outcome: "unknown" });
        expect(await b.getBilling(gone)).toBeNull();
      });
    });

    describe("API keys", () => {
      const keyHash = (n: string) => sha256Hex(`${tag}-key-${n}`);
      const create = async (data: AccountData, id: string, n: string) => {
        const r = await data.createApiKey(id, { keyHash: keyHash(n), hint: "0a1b" });
        if (r.outcome !== "created") throw new Error(`unexpected ${r.outcome}`);
        return r.key;
      };

      // Fails if a key is not found by its hash on another instance, the hash is returned, or another account sees it.
      it("creates a key found by its hash and listed for its account only, without the hash", async () => {
        const owner = await newAccount();
        const key = await create(a, owner, "one");
        expect(Number.isFinite(Date.parse(key.createdAt))).toBe(true);
        expect(await b.listApiKeys(owner)).toEqual([{ id: key.id, hint: "0a1b", createdAt: key.createdAt }]);
        expect(await b.findApiKeyAccount(keyHash("one"))).toBe(owner);
        expect(JSON.stringify(await b.listApiKeys(owner))).not.toContain(keyHash("one"));
        expect(await b.listApiKeys(await newAccount())).toEqual([]);
        expect(await b.listApiKeys("not-a-uuid")).toEqual([]);
      });

      // Fails if a revoked key still works, another account can revoke it, or a second revoke reports success.
      it("a revoked key is found no more; only its account revokes it, once", async () => {
        const owner = await newAccount();
        const key = await create(a, owner, "rev");
        expect(await b.revokeApiKey(await newAccount(), key.id)).toBe(false);
        expect(await b.findApiKeyAccount(keyHash("rev"))).toBe(owner);
        expect(await b.revokeApiKey(owner, key.id)).toBe(true);
        expect(await a.findApiKeyAccount(keyHash("rev"))).toBeNull();
        expect(await a.listApiKeys(owner)).toEqual([]);
        expect(await a.revokeApiKey(owner, key.id)).toBe(false);
        expect(await a.revokeApiKey(owner, "../keys")).toBe(false);
        expect(await a.findApiKeyAccount(keyHash("never"))).toBeNull();
        expect(await a.findApiKeyAccount("not-a-hash")).toBeNull();
      });

      // Fails if an account can hold more than MAX_API_KEYS active keys (also when creates race), or a revoked key still counts.
      it(`keeps at most ${MAX_API_KEYS} active keys per account, also when creates race`, async () => {
        const owner = await newAccount();
        const results = await Promise.all(Array.from({ length: MAX_API_KEYS + 3 }, (_, n) => (n % 2 ? a : b).createApiKey(owner, { keyHash: keyHash(`cap${n}`), hint: "0000" })));
        expect(results.filter((r) => r.outcome === "created")).toHaveLength(MAX_API_KEYS);
        expect(results.filter((r) => r.outcome === "full")).toHaveLength(3);
        const keys = await a.listApiKeys(owner);
        expect(keys).toHaveLength(MAX_API_KEYS);
        await a.revokeApiKey(owner, keys[0]!.id);
        expect((await b.createApiKey(owner, { keyHash: keyHash("cap-again"), hint: "0000" })).outcome).toBe("created");
      });

      // Fails if an invalid account, hash or hint reaches storage.
      it("refuses an invalid account id, hash or hint with RangeError", async () => {
        const owner = await newAccount();
        await expect(a.createApiKey("nope", { keyHash: keyHash("x"), hint: "0000" })).rejects.toThrow(RangeError);
        await expect(a.createApiKey(owner, { keyHash: "rk_retrofit_raw", hint: "0000" })).rejects.toThrow(RangeError);
        for (const hint of ["", "xyz!", "00000"]) await expect(a.createApiKey(owner, { keyHash: keyHash("x"), hint })).rejects.toThrow(RangeError);
        expect(await b.listApiKeys(owner)).toEqual([]);
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
