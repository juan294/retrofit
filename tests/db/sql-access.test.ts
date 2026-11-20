/**
 * Runs supabase/tests/store_access.sql with psql against the disposable stack
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

const sqlFile = fileURLToPath(new URL("../../supabase/tests/store_access.sql", import.meta.url));

// Fails if any table or function is usable by anon or authenticated, unusable by service_role,
// not security invoker with an empty search_path, or if a later table or function is usable by anon.
it("store access: anon and authenticated are denied, service_role works, later objects stay private", async () => {
  const run = promisify(execFile);
  let stdout = "";
  try {
    ({ stdout } = await run("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-f", sqlFile], { timeout: 60_000 }));
  } catch (error) {
    const e = error as { stderr?: string; code?: number };
    throw new Error(`psql exited ${e.code}: ${e.stderr ?? String(error)}`);
  }
  expect(stdout.trim().split("\n").at(-1)).toBe("store_access: ok");
}, 90_000);
