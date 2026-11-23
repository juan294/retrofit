// Copy for a feature that needs a plan, apart from the other billing copy, so that a page that can be
// refused one (/r, a claim panel) does not ship all of it.

import type { GatedFeature } from "@/lib/billing/plans";

export const PLAN_TEXT = {
  required: {
    publish: "Publishing and refreshing need a paid plan. Pages you already published stay public.",
    saved_reports: "Saving reports needs a paid plan. Reports you already saved stay in your account.",
    free_ai_preview: "While you are signed in, Retrofit's AI needs a paid plan. Use your own AI key to continue.",
    api_keys: "API keys need a paid plan.",
  } satisfies Record<GatedFeature, string>,
  unavailable: "Retrofit could not check your plan right now. Nothing was changed. Try again in a few minutes.",
  seePlans: "See the plans",
} as const;
