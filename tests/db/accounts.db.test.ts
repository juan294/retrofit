/**
 * The shared AccountData contract against the Supabase adapter on the disposable
 * gate stack (`pnpm test:db` applies every migration after a reset), with two
 * independent clients.
 */
import { expect, it } from "vitest";
import { sha256Hex } from "@/lib/security/tokens";
import { createSupabaseAccountData } from "@/lib/accounts/supabase";
import { createServiceClient } from "@/lib/supabase/client";
import { runAccountDataContract } from "../accounts/data-contract";

const url = process.env.SUPABASE_GATE_URL;
const serviceRoleKey = process.env.SUPABASE_GATE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error(
    "tests/db/accounts.db.test.ts needs SUPABASE_GATE_URL and SUPABASE_GATE_SERVICE_ROLE_KEY from a disposable Supabase stack with the migrations applied. Run it through pnpm test:db.",
  );
}

const admin = createServiceClient({ url, serviceRoleKey });

/** A Supabase Auth user (account rows reference auth.users), created through the admin API. */
async function newAccount(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email: `contract-${crypto.randomUUID()}@example.test`, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.code ?? "no user"}`);
  return data.user.id;
}

runAccountDataContract("supabase (two clients)", async () => ({
  a: createSupabaseAccountData({ url, serviceRoleKey }),
  b: createSupabaseAccountData({ url, serviceRoleKey }),
  newAccount,
}));

// Fails if the database clock and the adapter disagree on the recorded times by more than a minute
// (a wrong time zone or a missing default would show here).
it("records created and unsubscribed times close to now", async () => {
  const data = createSupabaseAccountData({ url, serviceRoleKey });
  const email = `clock-${Date.now()}@example.test`;
  const { unsubscribeToken } = await data.addNotifySignup(email, false);
  await data.unsubscribe(sha256Hex(unsubscribeToken as string));
  const row = await data.findNotifySignup(email);
  for (const t of [row?.createdAt, row?.unsubscribedAt]) expect(Math.abs(Date.parse(t as string) - Date.now())).toBeLessThan(60_000);
});
