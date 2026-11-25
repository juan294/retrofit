/** The purge of sign-in users without an account, and checkReady, against the disposable gate stack (`pnpm test:db`). */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createSupabaseAccountData } from "@/lib/accounts/supabase";
import { createServiceClient } from "@/lib/supabase/client";

const url = process.env.SUPABASE_GATE_URL;
const serviceRoleKey = process.env.SUPABASE_GATE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_GATE_DB_URL;
if (!url || !serviceRoleKey || !dbUrl) throw new Error("tests/db/purge.db.test.ts needs the disposable gate stack. Run it through pnpm test:db.");

const SQL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../supabase/tests/purge_access.sql");
const accounts = createSupabaseAccountData(createServiceClient({ url, serviceRoleKey }));

// Fails if a user with an account or any account row, or one whose link still works, is deleted; an unused or cancelled address stays; or
// anybody but service_role can run the function.
it("supabase/tests/purge_access.sql passes", async () => {
  const { stdout } = await promisify(execFile)("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-f", SQL], { timeout: 20_000 });
  expect(stdout).toContain("purge_access: ok");
});

// Fails if the adapter cannot call the function, or health names a missing object although every migration is applied.
it("the adapter purges through the function, and checkReady passes with every migration", async () => {
  expect(await accounts.purgeUsersWithoutAccount(new Date(Date.now() - 86_400_000).toISOString(), 0)).toBe(0);
  await accounts.checkReady();
});
