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
import { MAX_SAVED_REPORTS, type AccountData, type SaveReportInput, type SavedReportSummary } from "@/lib/accounts/data";
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
    });
  });
}
