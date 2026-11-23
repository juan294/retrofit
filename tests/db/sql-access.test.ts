/**
 * Runs supabase/tests/store_access.sql and accounts_access.sql with psql against the disposable stack
 * (`pg` is not a dependency, so the test uses the psql client at the process
 * boundary). The SQL file raises on any failed expectation and rolls back.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const dbUrl = process.env.SUPABASE_GATE_DB_URL;
if (!dbUrl) {
  throw new Error(
    "tests/db/sql-access.test.ts needs SUPABASE_GATE_DB_URL (the postgres connection string of a disposable Supabase stack with the store migration applied). Run it through pnpm test:db.",
  );
}

/** Runs one access script with psql and returns its last output line. */
async function runSql(name: string): Promise<string | undefined> {
  const sqlFile = fileURLToPath(new URL(`../../supabase/tests/${name}`, import.meta.url));
  const run = promisify(execFile);
  let stdout = "";
  try {
    ({ stdout } = await run("psql", [dbUrl as string, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-f", sqlFile], { timeout: 60_000 }));
  } catch (error) {
    const e = error as { stderr?: string; code?: number };
    throw new Error(`psql exited ${e.code}: ${e.stderr ?? String(error)}`);
  }
  return stdout.trim().split("\n").at(-1);
}

// Fails if any table or function is usable by anon or authenticated, unusable by service_role,
// not security invoker with an empty search_path, or if a later table or function is usable by anon.
it("store access: anon and authenticated are denied, service_role works, later objects stay private", async () => {
  expect(await runSql("store_access.sql")).toBe("store_access: ok");
}, 90_000);

// Fails if any of the eight account tables is usable by anon or authenticated, service_role lacks a
// data privilege or has more, a table has RLS off or a policy, a constraint or default the later phases
// rely on is missing, deleting an auth user leaves the account's rows (or deletes another's), or
// delete_account_data leaves a row or touches another account's, save_report stores a report twice or
// past its limit, or either function is executable by anon or authenticated.
it("accounts access: anon and authenticated are denied on every account table, service_role works, account rows cascade", async () => {
  expect(await runSql("accounts_access.sql")).toBe("accounts_access: ok");
}, 90_000);
