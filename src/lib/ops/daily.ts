import { utcDay } from "../fetch/limits";
import type { ServerDeps } from "../server/runtime";
import { openAlert } from "./alert";

type Deps = Pick<ServerDeps, "config" | "store" | "clock">;

/**
 * Opens one issue a day for a broken feature. The alert repository is public, so `body` holds no address, host,
 * customer id or error text. Never throws: an alert must not change the answer it belongs to.
 */
export async function alertToday(deps: Deps, name: string, title: string, body: string): Promise<void> {
  await openAlert({ key: `${name}:${utcDay(deps.clock())}`, title, body }, deps).catch((e: unknown) => {
    console.error(`Alert ${name} not sent:`, e instanceof Error ? e.name : "unknown error");
  });
}

/** Provider failures a day after which the owner is told: one or two can be transient. */
const PROVIDER_FAILURES = 3;

/** Sign-in could not send an email: the project's email limit (it stops sign-in for everybody), or the provider failed. */
export async function signInMailFailed(deps: Deps, kind: "limit" | "provider"): Promise<void> {
  if (kind === "provider") {
    const count = await deps.store.incrementWindow(`signin-provider-failures:${utcDay(deps.clock())}`, 24 * 3600).catch(() => 0);
    if (count < PROVIDER_FAILURES) return;
  }
  const why = kind === "limit" ? "The provider's hourly email limit for the whole project is used up." : `The provider failed to send ${PROVIDER_FAILURES} times today.`;
  await alertToday(deps, `sign-in-mail-${kind}`, "Sign-in email stopped", `${why} Visitors cannot sign in. Check the Supabase Auth limits and the Amazon SES account.`);
}
