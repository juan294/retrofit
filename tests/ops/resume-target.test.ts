import { describe, expect, it } from "vitest";
import { createHold, recordOverrun } from "@/lib/inference/hold";
import { createLedger } from "@/lib/inference/ledger";
import { RESUME_REQUIRED_ENV, ResumeTargetError, resumeTargetFromEnv } from "@/lib/inference/resume-target";
import { createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";
import { fakeClock } from "../helpers/server-deps";

const ENV = {
  SUPABASE_URL: "http://127.0.0.1:54731",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
  FREE_CREDIT_USD: "10",
  JUDGE_RESERVE_USD: "3",
  FREE_PRICE_IN_PER_M: "0.1",
  FREE_PRICE_OUT_PER_M: "0.4",
};

describe("resumeTargetFromEnv", () => {
  // Fails if the command can run against a store or ledger amounts the owner did not name.
  it.each(RESUME_REQUIRED_ENV)("refuses when %s is missing, naming it", (name) => {
    const env: Record<string, string | undefined> = { ...ENV, [name]: " " };
    expect(() => resumeTargetFromEnv(env)).toThrow(ResumeTargetError);
    expect(() => resumeTargetFromEnv(env)).toThrow(name);
  });

  // Fails if a malformed store URL reaches the Supabase client.
  it("refuses a store URL that is not http or https", () => {
    expect(() => resumeTargetFromEnv({ ...ENV, SUPABASE_URL: "ftp://example.test" })).toThrow(/SUPABASE_URL/);
    expect(() => resumeTargetFromEnv({ ...ENV, SUPABASE_URL: "not a url" })).toThrow(/SUPABASE_URL/);
  });

  // Fails if the reported target leaks the service role key or names a different origin.
  it("reports the store origin without the key", () => {
    const target = resumeTargetFromEnv({ ...ENV, SUPABASE_URL: "http://127.0.0.1:54731/rest/v1" });
    expect(target.origin).toBe("http://127.0.0.1:54731");
    expect(JSON.stringify(target)).not.toContain(ENV.SUPABASE_SERVICE_ROLE_KEY);
  });

  // Fails if the target ignores the configured amounts or does not run resumeFree over the store it built.
  it("inspects and resumes over the store it builds with the configured amounts", async () => {
    const clock = fakeClock(Date.parse("2026-11-15T12:00:00Z"));
    const store: Store = createMemoryStore({ clock: clock.now });
    const built: Array<{ url: string; serviceRoleKey: string }> = [];
    const target = resumeTargetFromEnv(
      { ...ENV, FREE_CREDIT_USD: "20", FREE_SERVICE_END: "2026-11-16T23:59:59Z" },
      {
        clock: clock.now,
        createStore: (options) => {
          built.push(options);
          return store;
        },
      },
    );
    expect(built).toEqual([{ url: "http://127.0.0.1:54731", serviceRoleKey: ENV.SUPABASE_SERVICE_ROLE_KEY }]);

    const deps = { store, config: target.config, clock: clock.now };
    const ledger = createLedger(deps);
    const r = await ledger.reserve({ pool: "public", sid: "s", microUsd: 700_000 });
    if (!r.ok) throw new Error("refused");
    await recordOverrun(deps, await ledger.reconcile(r.reservationId, 800_000), async () => {});

    const state = await target.inspect();
    expect(state).toMatchObject({ creditMicroUsd: 20_000_000, ledgerRemainingMicroUsd: 19_200_000, held: true });
    expect(await target.resume({ reconciledBalanceUsd: 19.2, note: "checked" })).toMatchObject({ ok: true });
    expect(await createHold(deps).isHeld()).toBe(false);
  });
});
