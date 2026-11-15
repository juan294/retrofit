import type { Config } from "../config";
import type { Store } from "../store/types";

/**
 * One GitHub issue for the owner. `key` identifies the alert: the same key is
 * never sent twice. Titles and bodies hold percentages and pool names only,
 * never amounts per visitor, keys, cookies or session ids.
 */
export interface Alert {
  readonly key: string;
  readonly title: string;
  readonly body: string;
}

export interface AlertDeps {
  readonly config: Pick<Config, "free">;
  readonly store: Store;
}

export interface AlertResult {
  readonly sent: boolean;
}

const KEY = /^[a-z0-9][a-z0-9:_-]{0,79}$/;
/** Held while the request is in flight, so a crash mid-request expires and a later run retries. */
const SENDING_TTL_S = 300;
/** After a sent issue: longer than the free period, so the alert never repeats. */
const SENT_TTL_S = 400 * 24 * 3600;
const GITHUB_TIMEOUT_MS = 10_000;

export function alertStoreKey(key: string): string {
  return `ops:alert:${key}`;
}

/**
 * Opens one GitHub issue in `config.free.alertRepo` for `alert.key`. The marker
 * is written before the request, so concurrent callers open one issue; a failed
 * request removes it so the next run retries.
 */
export async function openAlert(alert: Alert, deps: AlertDeps, options: { timeoutMs?: number } = {}): Promise<AlertResult> {
  if (!KEY.test(alert.key)) throw new Error(`invalid alert key: ${alert.key}`);
  const token = deps.config.free.alertGithubToken;
  if (!token) {
    console.error("Alert not sent: ALERT_GITHUB_TOKEN is not set");
    return { sent: false };
  }
  const marker = alertStoreKey(alert.key);
  const claim = await deps.store.putIfAbsent(marker, { state: "sending" }, SENDING_TTL_S);
  if (!claim.created) return { sent: false };

  let failure: string | null = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${deps.config.free.alertRepo}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: alert.title, body: alert.body }),
      signal: AbortSignal.timeout(options.timeoutMs ?? GITHUB_TIMEOUT_MS),
    });
    if (!res.ok) failure = `GitHub answered ${res.status}: ${await githubMessage(res)}`;
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  if (failure !== null) {
    await deps.store.delete(marker);
    console.error(`Alert ${alert.key} not sent: ${failure}`);
    return { sent: false };
  }
  await deps.store.set(marker, { state: "sent" }, SENT_TTL_S);
  return { sent: true };
}

/** The `message` field of a GitHub error body, short and single-line. */
async function githubMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let message = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string") {
      message = (parsed as { message: string }).message;
    }
  } catch {
    // Not JSON: keep the text.
  }
  return message.replace(/\s+/g, " ").slice(0, 200) || "(no body)";
}

/** A fraction as a percentage with at most one decimal: 0.5 -> "50%", 0.2345 -> "23.5%". */
export function percent(fraction: number): string {
  const value = Math.round(Math.max(0, fraction) * 1000) / 10;
  return `${value}%`;
}

/** Opened by the proxy at once when reported usage exceeds a reservation. `holdId` names the hold (one issue per hold). */
export function overrunAlert(holdId: string): Alert {
  return {
    key: `overrun:${holdId}`,
    title: "Free AI reservation overrun",
    body: [
      "Reported usage exceeded a reservation. The public pool is on hold; the judge pool keeps serving while its budget allows.",
      "",
      "Reconcile before resuming:",
      "1. Compare the reservation bound with the reported usage that exceeded it.",
      "2. Compare the configured prices with the provider's current prices.",
      "3. Read the provider balance.",
      "4. Check the outstanding reservations in the ledger.",
      "5. As an authorized production action, run `pnpm ops:resume-free --reconciled-balance <usd> --note <text>`.",
      "",
      "The hold never reopens by itself.",
    ].join("\n"),
  };
}
