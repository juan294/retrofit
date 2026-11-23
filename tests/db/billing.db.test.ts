/**
 * Billing races on the disposable gate stack that the memory adapter cannot show: a customer link for a
 * deleted auth user, and concurrent deliveries of many events for one customer.
 */
import { expect, it } from "vitest";
import { createSupabaseAccountData } from "@/lib/accounts/supabase";
import { createServiceClient } from "@/lib/supabase/client";
import { newAccount } from "./new-account";

const url = process.env.SUPABASE_GATE_URL;
const serviceRoleKey = process.env.SUPABASE_GATE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error("tests/db/billing.db.test.ts needs the disposable gate stack. Run it through pnpm test:db.");

const admin = createServiceClient({ url, serviceRoleKey });
const data = () => createSupabaseAccountData({ url, serviceRoleKey });
const tag = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const at = (ms: number) => new Date(Date.UTC(2027, 1, 1) + ms).toISOString();

// Fails if a late checkout or webhook can create a billing row for an account that is gone (an orphan row or an error instead of no_account).
it("a link for a deleted auth user answers no_account and creates nothing; deleting the user deletes its row", async () => {
  const a = data();
  const customer = `cus_${tag()}`;
  const gone = await newAccount(admin);
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
  await clients[0]!.linkBillingCustomer(owner, customer);
  const id = tag();
  const deliver = (n: number, c: number) =>
    clients[c]!.applyBillingEvent({ id: `evt_${id}_${n}`, type: "customer.subscription.updated" }, customer, { plan: n % 2 ? "pro" : "agency", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionId: `sub_${n}`, observedAt: at(n) });
  const order = [7, 0, 11, 3, 9, 1, 5, 10, 2, 8, 4, 6];
  const outcomes = (await Promise.all(order.flatMap((n) => [deliver(n, n % 3), deliver(n, (n + 1) % 3)]))).map((r) => r.outcome);
  expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(12);
  expect(await clients[1]!.getBilling(owner)).toMatchObject({ subscriptionId: "sub_11", plan: "pro", stateAt: at(11) });
}, 30_000);
