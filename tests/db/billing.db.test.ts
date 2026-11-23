/**
 * Billing races on the disposable gate stack that the memory adapter cannot show: a customer link for a
 * deleted auth user, and concurrent deliveries of many events for one customer.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createSupabaseAccountData } from "@/lib/accounts/supabase";
import { createServiceClient } from "@/lib/supabase/client";
import { newAccount } from "./new-account";

const url = process.env.SUPABASE_GATE_URL;
const serviceRoleKey = process.env.SUPABASE_GATE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_GATE_DB_URL;
if (!url || !serviceRoleKey || !dbUrl) throw new Error("tests/db/billing.db.test.ts needs the disposable gate stack. Run it through pnpm test:db.");

const admin = createServiceClient({ url, serviceRoleKey });
const query = async (sql: string) => (await promisify(execFile)("psql", [dbUrl, "-X", "-At", "-c", sql], { timeout: 10_000 })).stdout.trim();
const data = () => createSupabaseAccountData({ url, serviceRoleKey });
const tag = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const at = (ms: number) => new Date(Date.UTC(2027, 1, 1) + ms).toISOString();

// Fails if a late checkout or webhook can create a billing row for an account that is gone (an orphan row or an error instead of no_account).
it("a link for a deleted auth user answers no_account and creates nothing; deleting the user deletes its row", async () => {
  const a = data();
  const customer = `cus_${tag()}`;
  const gone = await newAccount(admin);
  await a.ensureProfile(gone);
  expect((await a.linkBillingCustomer(gone, customer)).outcome).toBe("linked");
  expect((await admin.auth.admin.deleteUser(gone)).error).toBeNull();
  expect(await a.getBillingByCustomer(customer)).toBeNull();
  expect(await a.linkBillingCustomer(gone, customer)).toEqual({ outcome: "no_account" });
  expect(await a.getBillingByCustomer(customer)).toBeNull();
});

// Fails if concurrent events deadlock, one is lost, or the final state is not the newest read's.
it("twelve concurrent events of one customer, delivered twice each, leave the newest read", async () => {
  const clients = [data(), data(), data()];
  const owner = await newAccount(admin);
  const customer = `cus_${tag()}`;
  await clients[0]!.ensureProfile(owner);
  await clients[0]!.linkBillingCustomer(owner, customer);
  const id = tag();
  const deliver = (n: number, c: number) =>
    clients[c]!.applyBillingEvent({ id: `evt_${id}_${n}`, type: "customer.subscription.updated" }, customer, { plan: n % 2 ? "pro" : "agency", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionId: `sub_${n}`, unpaidSince: null, observedAt: at(n) });
  const order = [7, 0, 11, 3, 9, 1, 5, 10, 2, 8, 4, 6];
  const outcomes = (await Promise.all(order.flatMap((n) => [deliver(n, n % 3), deliver(n, (n + 1) % 3)]))).map((r) => r.outcome);
  // A stale one is not recorded, so its second delivery is stale too; every applied one is applied once.
  expect(outcomes.every((o) => o === "applied" || o === "duplicate" || o === "stale")).toBe(true);
  expect(outcomes.filter((o) => o === "duplicate").length).toBeLessThanOrEqual(12);
  expect(await clients[1]!.getBilling(owner)).toMatchObject({ subscriptionId: "sub_11", plan: "pro", stateAt: at(11) });
}, 30_000);

// P5-R1. Fails if a link that races the deletion of the account's data leaves a billing row without a deletion mark: the deletion must
// wait for the link (and mark it), or the link must find the account gone.
it("a customer link racing the data deletion leaves either no row or a marked customer", async () => {
  const [a, b] = [data(), data()];
  for (let i = 0; i < 12; i++) {
    const owner = await newAccount(admin);
    await a.ensureProfile(owner);
    const customer = `cus_${tag()}`;
    const [link] = await Promise.all([a.linkBillingCustomer(owner, customer), b.deleteAccountData(owner)]);
    expect(await a.getBilling(owner)).toBeNull();
    expect(await a.isDeletedCustomer(customer)).toBe(link.outcome === "linked");
  }
}, 30_000);

// P5-R1. Fails if the data deletion takes its locks after a concurrent link committed (the row would stay, unmarked): the interleaving
// is fixed here, not raced. A psql session holds the link's lock until the deletion waits for it.
it("the data deletion waits for a link in progress and marks its customer", async () => {
  const a = data();
  const owner = await newAccount(admin);
  await a.ensureProfile(owner);
  const customer = `cus_${tag()}`;
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
  psql.stdin.write(`begin;\nselect public.link_billing_customer('${owner}', '${customer}') ->> 'outcome';\nselect 'held ' || pg_backend_pid();\n`);
  const pid = await held;
  const deletion = a.deleteAccountData(owner);
  const until = Date.now() + 8_000;
  while (!(await query(`select pid from pg_stat_activity where ${pid} = any (pg_blocking_pids(pid)) limit 1`))) {
    if (Date.now() > until) throw new Error("the deletion does not wait for the link");
    await new Promise((r) => setTimeout(r, 25));
  }
  psql.stdin.end("commit;\n\\q\n");
  await exited;
  await deletion;
  expect(await a.getBillingByCustomer(customer)).toBeNull();
  expect(await a.isDeletedCustomer(customer)).toBe(true);
}, 30_000);
