#!/usr/bin/env node
// Removes the free-path overrun hold after the owner reconciles (phase 6, "Ledger and quotas").
//
//   pnpm ops:resume-free --reconciled-balance <usd> --note <text>
//
// Prints the ledger total, outstanding reservations, the hold record and the bound
// parameters; refuses without a balance or note, and when the entered provider
// balance is below the ledger's remaining credit; writes an audit record
// `inference:audit:<time>`; then removes the hold. Running it against production is
// an authorized owner action.
//
// The work runs through injected hooks built on src/lib/inference/hold.ts
// (describeFreeState and resumeFree) over a Store. Until Phase 7 adds the production
// store, only tests supply hooks (with the memory store); the command itself exits 2.
import { pathToFileURL } from "node:url";

/**
 * @typedef {object} ResumeHooks
 * @property {() => Promise<any>} inspect describeFreeState over the target store
 * @property {(input: { reconciledBalanceUsd: number, note: string }) => Promise<any>} resume resumeFree over the target store
 * @property {(line: string) => void} [out]
 * @property {(line: string) => void} [err]
 */

const USAGE = "Usage: pnpm ops:resume-free --reconciled-balance <usd> --note <text>";

const usd = (micro) => `${(micro / 1_000_000).toFixed(6)} USD`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
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

/**
 * @param {string[]} argv
 * @param {ResumeHooks} [hooks]
 * @returns {Promise<number>} exit code: 0 resumed, 1 refused, 2 no store
 */
export async function main(argv, hooks) {
  const out = hooks?.out ?? ((line) => console.log(line));
  const err = hooks?.err ?? ((line) => console.error(line));
  let input;
  try {
    input = parseArgs(argv);
  } catch (error) {
    err(error.message);
    err(USAGE);
    return 1;
  }
  if (!hooks) {
    out("No production store configured until Phase 7");
    return 2;
  }
  printState(await hooks.inspect(), out);
  const result = await hooks.resume(input);
  if (!result.ok) {
    err(`Refused: ${result.message}`);
    return 1;
  }
  out(`Hold removed. Audit record: ${result.auditKey}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
