/**
 * Account deletion against a publish and against another account's verification, on the disposable gate stack
 * (P4-R2). The three functions must lock in one order (site_claims, then published_sites); with the deletion's
 * old order (published_sites first) each case below deadlocks, and PostgreSQL ends one side with 40P01.
 *
 * The interleaving is fixed, not raced: a psql session holds the row lock of the account's second publication,
 * so the deletion stops with its first lock taken; the other call then starts and waits; then psql lets go.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { AccountData, Claim } from "@/lib/accounts/data";
import { createSupabaseAccountData } from "@/lib/accounts/supabase";
import { sha256Hex } from "@/lib/security/tokens";
import { createServiceClient } from "@/lib/supabase/client";
import { storedSnapshotOf } from "../helpers/agent-snapshot";
import { newAccount } from "./new-account";

const url = process.env.SUPABASE_GATE_URL;
const serviceRoleKey = process.env.SUPABASE_GATE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_GATE_DB_URL;
if (!url || !serviceRoleKey || !dbUrl) throw new Error("tests/db/publish-race.db.test.ts needs the disposable gate stack. Run it through pnpm test:db.");

const admin = createServiceClient({ url, serviceRoleKey });
const data = (): AccountData => createSupabaseAccountData({ url, serviceRoleKey });
const run = promisify(execFile);
const query = async (sql: string) => (await run("psql", [dbUrl, "-X", "-At", "-c", sql], { timeout: 10_000 })).stdout.trim();

async function claimOf(d: AccountData, accountId: string, host: string): Promise<Claim> {
  const r = await d.createClaim(accountId, { host, method: "dns", tokenHash: sha256Hex(`${accountId}-${host}`) });
  if (r.outcome !== "created") throw new Error(r.outcome);
  return r.claim;
}
const verify = (d: AccountData, c: Claim) => d.verifyClaim(c.id, { tokenHash: c.tokenHash, checkedAt: "2026-11-23T09:00:00.000Z" });
const publish = (d: AccountData, accountId: string, host: string, day: number) =>
  d.publishSite(accountId, { host, snapshot: storedSnapshotOf(host, `2026-11-${day}T08:00:00.000Z`), report: { score: 1 }, fetchedAt: `2026-11-${day}T08:00:00.000Z`, now: `2026-11-${day}T09:00:00.000Z` });

/** Holds the row lock of `host`'s publication until `release` is called; `pid` is the holding session. */
async function holdPublication(host: string): Promise<{ pid: string; release: () => Promise<void> }> {
  const psql = spawn("psql", [dbUrl as string, "-X", "-At", "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve) => psql.once("exit", () => resolve()));
  const held = new Promise<string>((resolve) => {
    let out = "";
    psql.stdout.on("data", (chunk) => {
      out += String(chunk);
      const pid = /held (\d+)/.exec(out)?.[1];
      if (pid) resolve(pid);
    });
  });
  psql.stdin.write(`begin;\nselect 'held ' || pg_backend_pid() from public.published_sites where host = '${host}' for update;\n`);
  const pid = await held;
  return {
    pid,
    release: async () => {
      psql.stdin.end("commit;\n\\q\n");
      await exited;
    },
  };
}

/** Waits until a session waits for a lock of session `pid`, and returns that waiting session (other tests' waits do not count). */
async function waiterOf(pid: string): Promise<string> {
  const until = Date.now() + 8_000;
  for (;;) {
    const waiting = await query(`select pid from pg_stat_activity where ${pid} = any (pg_blocking_pids(pid)) limit 1`);
    if (waiting) return waiting;
    if (Date.now() > until) throw new Error(`no session waits for session ${pid}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** An account with two published hosts, the first one's publication stored first. */
async function twoPublished() {
  const a = data();
  const owner = await newAccount(admin);
  const tag = crypto.randomUUID().slice(0, 8);
  const hosts = [`race-a-${tag}.example.test`, `race-b-${tag}.example.test`] as const;
  for (const host of hosts) {
    expect((await verify(a, await claimOf(a, owner, host))).outcome).toBe("verified");
    expect((await publish(a, owner, host, 20)).outcome).toBe("published");
  }
  return { a, b: data(), owner, hosts };
}

// Fails (40P01, AccountDataUnavailable) if account deletion locks published_sites before site_claims.
it("account deletion and a publish of the same account never deadlock; the deletion wins or the publish finds no claim", async () => {
  const { a, b, owner, hosts } = await twoPublished();
  const held = await holdPublication(hosts[1]);
  const deletion = a.deleteAccountData(owner).then(() => "deleted", (e: Error) => e.message);
  const deleting = await waiterOf(held.pid);
  const refresh = publish(b, owner, hosts[0], 21).then((r) => r.outcome, (e: Error) => e.message);
  await waiterOf(deleting);
  await held.release();
  expect(await Promise.all([deletion, refresh])).toEqual(["deleted", "no_claim"]);
  for (const host of hosts) expect(await a.getPublicSite(host)).toBeNull();
  expect(await a.listPublishedSites(owner)).toEqual([]);
}, 60_000);

// Fails (40P01, AccountDataUnavailable) if account deletion locks published_sites before site_claims.
it("account deletion and another account's verification of its host never deadlock", async () => {
  const { a, b, owner, hosts } = await twoPublished();
  const other = await newAccount(admin);
  const claim = await claimOf(b, other, hosts[0]);
  const held = await holdPublication(hosts[1]);
  const deletion = a.deleteAccountData(owner).then(() => "deleted", (e: Error) => e.message);
  const deleting = await waiterOf(held.pid);
  const verification = verify(b, claim).then((r) => r.outcome, (e: Error) => e.message);
  await waiterOf(deleting);
  await held.release();
  expect(await Promise.all([deletion, verification])).toEqual(["deleted", "verified"]);
  expect(await a.listClaims(owner)).toEqual([]);
  expect(await a.listPublishedSites(owner)).toEqual([]);
  expect((await b.getClaim(other, claim.id))?.status).toBe("verified");
}, 60_000);
