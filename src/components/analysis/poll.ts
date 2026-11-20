/** Polling interval after `elapsedMs`: every 1 s for 10 s, then every 2 s until 30 s, then every 5 s. */
export function pollDelay(elapsedMs: number): number {
  if (elapsedMs < 10_000) return 1000;
  if (elapsedMs < 30_000) return 2000;
  return 5000;
}

/** States after which the status never changes, so polling stops. `ready` is final only once its score is readable. */
const STOP_STATUSES = new Set(["failed", "expired"]);

export type PollAction = "read-result" | "stop" | "poll";

/**
 * What the analysis page does after a status response: read the result once
 * the score is ready, stop on a final failure, otherwise poll again. A `ready`
 * status without `scoreReady` keeps polling, so the page never stops on a
 * state that still shows "Reading the site".
 */
export function pollAction(body: { readonly status: string; readonly scoreReady: boolean }): PollAction {
  if (body.scoreReady) return "read-result";
  if (STOP_STATUSES.has(body.status)) return "stop";
  return "poll";
}
