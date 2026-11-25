import { ConfigError, loadConfig } from "./config";

/**
 * Stops a Vercel production build whose configuration production would refuse (next.config.ts calls it).
 * Without it the build succeeds, takes the domain, and then every route fails. The message names the variable
 * and nothing else: a build log must never hold a value.
 */
export function checkProductionBuild(env: Readonly<Record<string, string | undefined>>): void {
  if (env.VERCEL_ENV !== "production") return;
  try {
    loadConfig(env);
  } catch (e) {
    const variable = e instanceof ConfigError ? e.variable : "the configuration";
    throw new Error(`The production configuration is not valid: ${variable}. See docs/release/release-playbook.md.`);
  }
}
