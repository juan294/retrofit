/** Polling interval after `elapsedMs`: every 1 s for 10 s, then every 2 s until 30 s, then every 5 s. */
export function pollDelay(elapsedMs: number): number {
  if (elapsedMs < 10_000) return 1000;
  if (elapsedMs < 30_000) return 2000;
  return 5000;
}

export const FINAL_STATUSES = new Set(["ready", "failed", "expired"]);
