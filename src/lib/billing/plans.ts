/**
 * Retrofit's plans and the features each one includes: one table that the
 * pricing page, the entitlement check (entitlements.ts) and the tests read. Plan ids
 * match `billing_customers.plan` in supabase/migrations/*_accounts.sql.
 *
 * No amounts here: prices are Stripe configuration, decided later. Before
 * BILLING_START every visitor and account keeps every feature.
 */

export type PlanId = "free" | "pro" | "agency";
export type PaidPlanId = Exclude<PlanId, "free">;

export type Feature =
  | "analyze"
  | "preview_own_key"
  | "download_bundle"
  | "publish"
  | "badge"
  | "saved_reports"
  | "free_ai_preview"
  | "api_keys"
  | "api_high_volume";

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  readonly summary: string;
  readonly features: readonly Feature[];
  /** Site scores per hour of the account's API keys together (GET /api/score); null without API keys. */
  readonly scoresPerHour: number | null;
}

/** The text the pricing page shows for each feature. */
export const FEATURE_LABELS: Readonly<Record<Feature, string>> = {
  analyze: "Score any public website for AI agents",
  preview_own_key: "Try the preview agent with your own AI key",
  download_bundle: "Download the files to install on a site you own",
  publish: "Publish the agent on Retrofit for a site you have claimed",
  badge: "Embed the agent-ready badge on your site",
  saved_reports: "Keep reports after the analysis expires",
  free_ai_preview: "Try the preview agent on Retrofit's AI while you are signed in, without a key",
  api_keys: "API keys for the score API",
  api_high_volume: "Higher score API limits for checking many sites",
};

const FREE: readonly Feature[] = ["analyze", "preview_own_key", "download_bundle"];
const PRO: readonly Feature[] = [...FREE, "publish", "badge", "saved_reports", "free_ai_preview", "api_keys"];
const AGENCY: readonly Feature[] = [...PRO, "api_high_volume"];

export const PLANS: readonly Plan[] = [
  { id: "free", name: "Free", summary: "Check your site and try its agent with your own AI key.", features: FREE, scoresPerHour: null },
  { id: "pro", name: "Pro", summary: "Publish the agent for a site you own, with the badge and saved reports.", features: PRO, scoresPerHour: 60 },
  { id: "agency", name: "Agency", summary: "For agencies that check many client and prospect sites.", features: AGENCY, scoresPerHour: 300 },
];

export const isPaidPlan = (id: unknown): id is PaidPlanId => id === "pro" || id === "agency";

export function planOf(id: PlanId): Plan {
  return PLANS.find((p) => p.id === id) ?? PLANS[0]!;
}

export function planIncludes(id: PlanId, feature: Feature): boolean {
  return planOf(id).features.includes(feature);
}
