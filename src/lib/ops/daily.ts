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

/** Runs an alert after the answer. Never throws, also where the platform offers no background work. */
export function inBackground(deps: Pick<ServerDeps, "waitUntil">, task: () => Promise<unknown>): void {
  try {
    deps.waitUntil(task().catch(() => undefined));
  } catch {
    console.error("Alert not sent: no background work is available");
  }
}

/** Provider failures a day after which the owner is told: one or two can be transient. */
const PROVIDER_FAILURES = 3;

async function third(deps: Deps, name: string): Promise<boolean> {
  return (await deps.store.incrementWindow(`${name}-failures:${utcDay(deps.clock())}`, 24 * 3600)) >= PROVIDER_FAILURES;
}

/** Sign-in could not send an email: the project's email limit (it stops sign-in for everybody), or a provider outage. */
export async function signInMailFailed(deps: Deps, kind: "limit" | "provider"): Promise<void> {
  if (kind === "provider" && !(await third(deps, "signin-provider"))) return;
  const why = kind === "limit" ? "The provider's hourly email limit for the whole project is used up." : `The provider failed to send ${PROVIDER_FAILURES} times today.`;
  await alertToday(deps, `sign-in-mail-${kind}`, "Sign-in email stopped", `${why} Visitors may not be able to sign in. Check the Supabase Auth limits and the Amazon SES account.`);
}

/** The provider could not check a link (an outage, or its shared limit of checks). */
export async function signInCheckFailed(deps: Deps): Promise<void> {
  if (!(await third(deps, "signin-check"))) return;
  await alertToday(deps, "sign-in-check", "Sign-in links cannot be checked", `The provider failed to check a link ${PROVIDER_FAILURES} times today. Visitors may not be able to sign in. Check the Supabase Auth status and its token_verifications limit.`);
}
