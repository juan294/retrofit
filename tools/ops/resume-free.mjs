#!/usr/bin/env node
// Removes the free-path overrun hold after the owner reconciles (phase 6, "Ledger and quotas").
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... FREE_CREDIT_USD=... JUDGE_RESERVE_USD=... \
//   FREE_PRICE_IN_PER_M=... FREE_PRICE_OUT_PER_M=... FREE_SERVICE_END=... \
//   pnpm ops:resume-free --reconciled-balance <usd> --note <text>
//
// Accepts a leading "--" (pnpm passes it through). Checks the owner's authorization inputs first
// (the reconciled provider balance and a note), then builds the Supabase store named by the
// environment (src/lib/inference/resume-target.ts; every variable above is required, with the
// deployment's values). The fee, bound and limit settings keep their config.ts defaults when
// unset, so the command prints every effective setting and marks each default: set any that the
// deployment overrides. It then prints the target store's origin, the ledger total, outstanding
// reservations, the hold record and the bound parameters; refuses when the entered provider
// balance is below the ledger's remaining credit; writes an audit record
// `inference:audit:<time>`; then clears the hold through resumeFree (src/lib/inference/hold.ts),
// which refuses and keeps the hold when a new overrun is recorded while it runs, and records a
// refusal or a store failure in the audit trail. Running it against production is an authorized
// owner action.
//
// Exit status: 0 resumed; 1 refused (arguments, balance, no hold, or a concurrent hold event);
// 2 no target (store or ledger configuration missing); 3 store error (nothing is reported as
// resumed; rerun after the store recovers).
import { pathToFileURL } from "node:url";

/**
 * @typedef {object} ResumeHooks
 * @property {string} [origin] the target store's origin, printed before any change
 * @property {{ name: string, value: string, source: "set" | "default" }[]} [settings] effective free-path settings, printed before any change
 * @property {() => Promise<any>} inspect describeFreeState over the target store
 * @property {(input: { reconciledBalanceUsd: number, note: string }) => Promise<any>} resume resumeFree over the target store
 * @property {(line: string) => void} [out]
 * @property {(line: string) => void} [err]
 */

const USAGE = "Usage: pnpm ops:resume-free --reconciled-balance <usd> --note <text>";

const usd = (micro) => `${(micro / 1_000_000).toFixed(6)} USD`;

function parseArgs(argv) {
  const args = {};
  // `pnpm ops:resume-free -- --reconciled-balance ...` passes the separator through.
  for (let i = argv[0] === "--" ? 1 : 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === "--reconciled-balance" || flag === "--note") && value !== undefined && !value.startsWith("--")) {
      args[flag.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${flag}`);
    }
  }
  const raw = args["reconciled-balance"];
  if (raw === undefined) throw new Error("--reconciled-balance <usd> is required (the provider balance you reconciled)");
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new Error(`--reconciled-balance must be a USD amount such as 9.25, got "${raw}"`);
  const note = (args.note ?? "").trim();
  if (!note) throw new Error("--note <text> is required (what you reconciled)");
  return { reconciledBalanceUsd: Number(raw), note };
}

function printState(state, out) {
  out(`Ledger spent: ${usd(state.totalSpentMicroUsd)}`);
  out(`Outstanding reservations: ${usd(state.totalOutstandingMicroUsd)}`);
  out(`Ledger remaining credit: ${usd(state.ledgerRemainingMicroUsd)} of ${usd(state.creditMicroUsd)}`);
  out(`Hold: ${state.hold ? JSON.stringify(state.hold) : state.held ? "flag set, no record" : "none"}`);
  out(`Bound parameters: ${JSON.stringify(state.bound)}`);
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {string[]} argv
 * @param {ResumeHooks | (() => Promise<ResumeHooks>)} target the hooks, or a function that builds them
 *   (called only after the arguments are valid)
 * @returns {Promise<number>} exit code: 0 resumed, 1 refused, 2 no target, 3 store error
 */
export async function main(argv, target) {
  const out = (typeof target === "object" && target?.out) || ((line) => console.log(line));
  const err = (typeof target === "object" && target?.err) || ((line) => console.error(line));
  let input;
  try {
    input = parseArgs(argv);
  } catch (error) {
    err(error.message);
    err(USAGE);
    return 1;
  }
  let hooks;
  try {
    hooks = typeof target === "function" ? await target() : target;
  } catch (error) {
    err(`No target store: ${messageOf(error)}`);
    return 2;
  }
  if (!hooks) {
    err("No target store configured.");
    return 2;
  }
  if (hooks.origin) out(`Store: ${hooks.origin}`);
  if (hooks.settings?.length) {
    out("Settings (default = not set in the environment; check it matches the deployment):");
    for (const s of hooks.settings) out(`  ${s.name}=${s.value} (${s.source})`);
  }
  let result;
  try {
    printState(await hooks.inspect(), out);
    result = await hooks.resume(input);
  } catch (error) {
    const cause = error instanceof Error && error.cause ? ` (${messageOf(error.cause)})` : "";
    err(`Store error: ${messageOf(error)}${cause}. Nothing was reported as resumed; check the hold and rerun when the store is reachable.`);
    return 3;
  }
  if (!result.ok) {
    err(`Refused: ${result.message}`);
    return 1;
  }
  out(`Hold removed. Audit record: ${result.auditKey}`);
  return 0;
}

/** The production target: the Supabase store and ledger amounts named by the environment. */
async function targetFromEnv() {
  const { registerSourceHooks, sourceUrl } = await import("./source-hooks.mjs");
  registerSourceHooks();
  const { resumeTargetFromEnv } = await import(sourceUrl("lib/inference/resume-target.ts"));
  return resumeTargetFromEnv(process.env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), targetFromEnv).then((code) => process.exit(code));
}
