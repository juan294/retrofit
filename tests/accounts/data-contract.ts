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
import { hashToken, type AccountData } from "@/lib/accounts/data";

export interface AccountDataClients {
  a: AccountData;
  b: AccountData;
}

const TOKEN = /^[0-9a-f]{32}$/;

export function runAccountDataContract(name: string, makeClients: () => Promise<AccountDataClients>): void {
  describe(`AccountData contract: ${name}`, () => {
    let a: AccountData;
    let b: AccountData;
    let tag: string;
    const email = (local: string) => `${local}-${tag}@example.test`;

    beforeEach(async () => {
      ({ a, b } = await makeClients());
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
        expect(await b.unsubscribe(hashToken(unsubscribeToken as string))).toBe("unsubscribed");
        const row = await a.findNotifySignup(email("u"));
        expect(row?.unsubscribedAt).toEqual(expect.any(String));
        expect(Number.isFinite(Date.parse(row?.unsubscribedAt as string))).toBe(true);
      });

      // Fails if a second click moves the recorded time or reports an error.
      it("is idempotent: a second unsubscribe answers already and keeps the first time", async () => {
        const { unsubscribeToken } = await a.addNotifySignup(email("u2"), false);
        const hash = hashToken(unsubscribeToken as string);
        await a.unsubscribe(hash);
        const first = (await a.findNotifySignup(email("u2")))?.unsubscribedAt;
        expect(await b.unsubscribe(hash)).toBe("already");
        expect((await b.findNotifySignup(email("u2")))?.unsubscribedAt).toBe(first);
      });

      // Fails if an unknown or malformed hash unsubscribes anything or throws.
      it("answers unknown for a hash that matches no signup, or is not a SHA-256 hex digest", async () => {
        const { unsubscribeToken } = await a.addNotifySignup(email("keep"), false);
        expect(await a.unsubscribe(hashToken(`${unsubscribeToken}x`))).toBe("unknown");
        expect(await a.unsubscribe("not-a-hash")).toBe("unknown");
        expect(await a.unsubscribe(unsubscribeToken as string)).toBe("unknown");
        expect((await b.findNotifySignup(email("keep")))?.unsubscribedAt).toBeNull();
      });

      // Fails if a repeat signup re-subscribes an address that unsubscribed (anyone could re-subscribe someone else).
      it("a signup after unsubscribing stays unsubscribed", async () => {
        const { unsubscribeToken } = await a.addNotifySignup(email("back"), false);
        await a.unsubscribe(hashToken(unsubscribeToken as string));
        expect((await b.addNotifySignup(email("back"), true)).created).toBe(false);
        const row = await a.findNotifySignup(email("back"));
        expect(row?.unsubscribedAt).not.toBeNull();
        expect(row?.marketingConsent).toBe(false);
      });
    });
  });
}
