import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { FEATURE_LABELS, PLANS, type Feature } from "@/lib/billing/plans";

describe("plans table", () => {
  // Fails if a plan is renamed, reordered or dropped (the pricing page, entitlements and the database read these ids).
  it("has Free, Pro and Agency in that order", () => {
    expect(PLANS.map((p) => [p.id, p.name])).toEqual([
      ["free", "Free"],
      ["pro", "Pro"],
      ["agency", "Agency"],
    ]);
  });

  // Fails if the database accepts a different set of plan ids than the code knows.
  it("matches the plan ids allowed by billing_customers.plan in the migration", () => {
    const sql = fs.readFileSync(new URL("../../supabase/migrations/20261123120000_accounts.sql", import.meta.url), "utf8");
    const allowed = /plan in \(([^)]*)\)/.exec(sql)?.[1]?.split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(allowed).toEqual(PLANS.map((p) => p.id));
  });

  // Fails if a higher plan loses a feature of a lower one, or a feature has no label for the pricing page.
  it("each plan includes every feature of the plan before it, and every feature has a label", () => {
    for (let i = 1; i < PLANS.length; i++) {
      for (const f of PLANS[i - 1]!.features) expect(PLANS[i]!.features, `${PLANS[i]!.id} lacks ${f}`).toContain(f);
      expect(PLANS[i]!.features.length).toBeGreaterThan(PLANS[i - 1]!.features.length);
    }
    for (const p of PLANS) for (const f of p.features) expect(FEATURE_LABELS[f as Feature]).toEqual(expect.any(String));
  });

  // Fails if publishing or the badge is free (a claim and a paid plan control them after billing starts), or the free plan loses the own-key preview.
  it("keeps publishing, the badge, saved reports and API keys out of Free", () => {
    const free = PLANS[0]!.features;
    for (const f of ["publish", "badge", "saved_reports", "api_keys"] as const) expect(free).not.toContain(f);
    expect(free).toEqual(expect.arrayContaining(["analyze", "preview_own_key", "download_bundle"]));
  });

  // Fails if an amount appears in the plans table (prices are configuration, decided later).
  it("carries no amounts", () => {
    expect(JSON.stringify(PLANS)).not.toMatch(/[$€£]|\b\d+([.,]\d+)?\s*(usd|eur|gbp|\/\s*mo|per month)\b/i);
  });
});
