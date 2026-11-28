import type { ServiceClient } from "@/lib/supabase/client";

/** A new Supabase Auth user on the gate stack (account rows reference auth.users), created through the admin API. Returns its id. */
export async function newAccount(admin: ServiceClient): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email: `db-${crypto.randomUUID()}@example.test`, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.code ?? "no user"}`);
  return data.user.id;
}
