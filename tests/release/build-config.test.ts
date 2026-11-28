import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkProductionBuild } from "@/lib/build-config";
import { VERCEL_ENV } from "../helpers/vercel-env";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// AR-H1: without this, a missing variable builds, takes the production domain and then fails on every route.
describe("the production build's configuration check", () => {
  // Fails if a production build with a missing or malformed variable passes, or its message holds any value of the environment.
  it.each([
    ["SUPABASE_ANON_KEY", undefined],
    ["BILLING_START", undefined],
    ["BILLING_START", "2027-01-19T00:00:00Z"],
    ["STRIPE_SECRET_KEY", "sk_live_51SecretSecret"],
    ["FREE_CREDIT_USD", "ten-secret-dollars"],
    ["OTARI_REGION", "secret-region"],
  ])("refuses %s = %s and names only the variable", (name, value) => {
    const env = { ...VERCEL_ENV, VERCEL_ENV: "production", [name]: value };
    let message = "";
    try {
      checkProductionBuild(env);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain(name);
    for (const secret of [value, ...Object.values(VERCEL_ENV)]) if (secret && secret.length > 4) expect(message).not.toContain(secret);
  });

  // Fails if a valid production build is refused, or a preview, local or CI build needs production variables.
  it("accepts a valid production environment and checks no other build", () => {
    expect(() => checkProductionBuild({ ...VERCEL_ENV, VERCEL_ENV: "production" })).not.toThrow();
    for (const env of [{}, { VERCEL: "1" }, { VERCEL: "1", VERCEL_ENV: "preview" }, { CI: "1" }]) expect(() => checkProductionBuild(env)).not.toThrow();
  });

  // Fails if the build stops calling the check, or the functions leave the database's region (PE-L1).
  it("runs from next.config.ts, and vercel.json pins the functions beside the database", () => {
    expect(fs.readFileSync(path.join(ROOT, "next.config.ts"), "utf8")).toMatch(/^checkProductionBuild\(process\.env\);$/m);
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8")).regions).toEqual(["iad1"]);
  });
});
