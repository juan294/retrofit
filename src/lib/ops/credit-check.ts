import { sameHash } from "../analysis/visitor";
import { json } from "../api/json";
import type { ServerDeps } from "../server/runtime";
import { openAlert, overrunAlert, percent, type Alert, type AlertDeps } from "./alert";
import { ledgerViewFor, type LedgerView } from "./ledger-view";

/** The judge alert opens when less than this fraction of the judge reserve remains. */
export const JUDGE_LOW_FRACTION = 0.25;

const MICRO = 1_000_000;

export interface Shares {
  /** (spent + outstanding) / credit. */
  readonly used: number;
  readonly spent: number;
  readonly outstanding: number;
  readonly publicSpent: number;
  /** Judge spending as a fraction of the judge reserve. */
  readonly judgeSpentOfReserve: number;
  /**
   * What the judge pool can still spend, as a fraction of the reserve: the
   * reserve less judge spending, or the remaining credit when that is lower
   * (public spending past its budget reaches the reserve).
   */
  readonly judgeRemaining: number;
}

function shares(deps: AlertDeps, v: LedgerView): Shares {
  const credit = deps.config.free.creditUsd * MICRO;
  const reserve = deps.config.free.judgeReserveUsd * MICRO;
  const used = v.totalSpentMicro + v.totalOutstandingMicro;
  const judgeLeft = Math.max(0, Math.min(reserve - v.judgeSpentMicro, credit - used));
  return {
    used: used / credit,
    spent: v.totalSpentMicro / credit,
    outstanding: v.totalOutstandingMicro / credit,
    publicSpent: Math.max(0, v.totalSpentMicro - v.judgeSpentMicro) / credit,
    judgeSpentOfReserve: v.judgeSpentMicro / reserve,
    judgeRemaining: judgeLeft / reserve,
  };
}

function poolLines(s: Shares): string[] {
  return [
    `Used (spent and reserved): ${percent(s.used)} of the credit.`,
    `Spent: ${percent(s.spent)} of the credit.`,
    `Outstanding reservations: ${percent(s.outstanding)} of the credit.`,
    `Public pool spent: ${percent(s.publicSpent)} of the credit.`,
    `Judge pool spent: ${percent(s.judgeSpentOfReserve)} of the judge reserve.`,
    `Judge pool remaining: ${percent(s.judgeRemaining)} of the judge reserve.`,
  ];
}

export function thresholdAlert(threshold: number, s: Shares): Alert {
  return {
    key: `threshold:${Math.round(threshold * 100)}`,
    title: "Free AI credit threshold reached",
    body: [
      `${percent(threshold)} of the free AI credit is used.`,
      "",
      ...poolLines(s),
      "",
      "Add credit, lower the caps or accept.",
    ].join("\n"),
  };
}

export function judgeReserveAlert(s: Shares): Alert {
  return {
    key: "judge-reserve-low",
    title: "Free AI judge reserve low",
    body: [
      `${percent(s.judgeRemaining)} of the judge reserve remains.`,
      `The alert opens below ${percent(JUDGE_LOW_FRACTION)}.`,
      "",
      ...poolLines(s),
      "",
      "Add credit or lower the public caps so judges keep access.",
    ].join("\n"),
  };
}

/**
 * Opens the threshold alert the first time each threshold is crossed, and the
 * judge alert when less than 25% of the judge reserve remains, and the overrun
 * alert while a hold exists (so a failed send from the proxy is retried). Returns the keys
 * opened by this run.
 */
export async function runCreditCheck(deps: AlertDeps, view: LedgerView): Promise<{ alerts: string[] }> {
  const s = shares(deps, view);
  const due: Alert[] = deps.config.free.alertThresholds.filter((t) => s.used >= t).map((t) => thresholdAlert(t, s));
  if (s.judgeRemaining < JUDGE_LOW_FRACTION) due.push(judgeReserveAlert(s));
  // While a hold exists, retry its overrun alert (one issue per hold: openAlert is idempotent by key).
  if (view.holdId) due.push(overrunAlert(view.holdId));
  const alerts: string[] = [];
  for (const alert of due) {
    if ((await openAlert(alert, deps)).sent) alerts.push(alert.key);
  }
  return { alerts };
}

/** GET /api/cron/credit-check (Vercel Cron). `Authorization: Bearer <CRON_SECRET>`, compared in constant time. */
export async function handleCreditCheck(
  request: Request,
  deps: ServerDeps,
  viewFor: (deps: ServerDeps) => Promise<LedgerView> = ledgerViewFor,
): Promise<Response> {
  const secret = deps.config.free.cronSecret;
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (request.method !== "GET" || !secret || !sameHash(token, secret)) return json(401, { error: "unauthorized" });

  let view: LedgerView;
  try {
    view = await viewFor(deps);
  } catch (e) {
    console.error("Credit check unavailable:", e instanceof Error ? e.message : String(e));
    return json(503, { error: "unavailable" });
  }
  const { alerts } = await runCreditCheck(deps, view);
  return json(200, { checked: true, alerts });
}
