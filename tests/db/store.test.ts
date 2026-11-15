/**
 * The shared Store contract against the Supabase adapter on a disposable stack,
 * with two independent clients and the real clock. `pnpm test:db` (the gate
 * database tool) starts the stack, applies the migration and provides the
 * variables below.
 */
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createSupabaseStore } from "@/lib/store/supabase";
import { runStoreContract } from "../store/contract";

const url = process.env.SUPABASE_GATE_URL;
const serviceRoleKey = process.env.SUPABASE_GATE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error(
    "tests/db/store.test.ts needs SUPABASE_GATE_URL and SUPABASE_GATE_SERVICE_ROLE_KEY from a disposable Supabase stack with the store migration applied. Run it through pnpm test:db.",
  );
}

// Real sleeps of up to 2.5 s per test, plus network round trips.
vi.setConfig({ testTimeout: 20_000 });

runStoreContract("supabase (two clients, real clock)", async () => ({
  a: createSupabaseStore({ url, serviceRoleKey }),
  b: createSupabaseStore({ url, serviceRoleKey }),
  clock: {
    now: () => Date.now(),
    advance: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
  // Keys are namespaced per test and the stack is disposed after the run.
  cleanup: async () => {},
}));

// Fails if store_cleanup leaves expired rows, deletes live ones, or the count is not returned.
it("cleanup deletes expired rows across tables and keeps live ones", async () => {
  const store = createSupabaseStore({ url, serviceRoleKey });
  const ns = `cleanup-${randomUUID()}`;
  await store.set(`${ns}:expired`, 1, 1);
  await store.acquireLease(`${ns}:lease`, 1);
  await store.enqueue(`${ns}:q`, "x", 1);
  await store.incrementWindow(`${ns}:w`, 1);
  await store.set(`${ns}:live`, 2, 600);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(await store.cleanup()).toBeGreaterThanOrEqual(4);
  expect(await store.get(`${ns}:live`)).toBe(2);
  expect(await store.acquireLease(`${ns}:lease`, 600)).toEqual(expect.any(String));
});
