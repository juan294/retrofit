import { getJob, isQueueExpired, startOrJoinCrawl, updateJob, type JobDeps } from "@/lib/crawl/jobs";
import { runCrawl, type WorkerOutcome } from "@/lib/crawl/worker";
import { countOnce, nextUtcMidnight, shortHash, ttlUntil, utcDay } from "@/lib/fetch/limits";
import type { ServerDeps } from "@/lib/server/runtime";
import { visitorTexts } from "./texts";

/**
 * Global crawl capacity (phase-3.md "Capacity"):
 * - CRAWL_MAX_CONCURRENT slots, each a Store lease `crawl-slot:<n>` with the
 *   crawl lease TTL, so a crashed worker's slot frees itself;
 * - the Store queue `crawl-queue`, whose items live QUEUE_MAX_WAIT_S;
 * - a daily counter of distinct input origins against CRAWL_MAX_HOSTS_PER_DAY.
 */
export const CRAWL_QUEUE = "crawl-queue";
export const slotKey = (n: number) => `crawl-slot:${n}`;

export interface Slot {
  readonly key: string;
  readonly token: string;
}

/** Takes the first free slot, or null when all are held. */
export async function acquireSlot(deps: Pick<ServerDeps, "store" | "config">): Promise<Slot | null> {
  for (let n = 0; n < deps.config.crawlMaxConcurrent; n++) {
    const key = slotKey(n);
    const token = await deps.store.acquireLease(key, deps.config.crawlLeaseTtlS);
    if (token) return { key, token };
  }
  return null;
}

export type StartCrawlResult =
  | { readonly ok: true; readonly jobId: string; readonly created: boolean }
  | { readonly ok: false; readonly code: "daily_limit"; readonly retryAt: number };

/**
 * startOrJoinCrawl plus capacity: a new job counts against the daily origin cap
 * and is queued. The caller then calls dispatchQueued, which starts it when a
 * slot is free. A job over the daily cap is marked failed `daily_limit`, so it
 * is never reused and a later request (after 00:00 UTC) creates a new one.
 */
export async function startCrawlJob(deps: JobDeps, inputOrigin: string): Promise<StartCrawlResult> {
  const { jobId, created } = await startOrJoinCrawl(deps, inputOrigin);
  if (!created) return { ok: true, jobId, created };
  const now = deps.clock();
  const midnight = nextUtcMidnight(now);
  const ttl = ttlUntil(midnight, now);
  const day = utcDay(now);
  const allowed = await countOnce(deps.store, `crawl-origin-day:${day}:${shortHash(inputOrigin)}`, `crawl-origins:${day}`, ttl, deps.config.crawlMaxHostsPerDay);
  if (!allowed) {
    const job = await getJob(deps.store, jobId);
    if (job) await updateJob(deps, job, { status: "failed", step: "failed", failure: { code: "daily_limit", message: visitorTexts.dailyLimit } });
    return { ok: false, code: "daily_limit", retryAt: midnight };
  }
  await deps.store.enqueue(CRAWL_QUEUE, jobId, deps.config.queueMaxWaitS);
  return { ok: true, jobId, created };
}

/**
 * Starts queued jobs while slots and queued jobs remain (phase-3.md
 * `dispatchQueued`). Called at the end of every worker run and on every
 * analyze, status and score request. Returns the number of workers emitted.
 *
 * Each emitted worker first checks its job: a job that is no longer queued or
 * whose queue time passed is skipped, its slot released and dispatch repeated
 * (the pseudo-code's "fail" line). The check runs inside the worker task, so a
 * request that dispatches makes no extra job read of its own.
 */
export async function dispatchQueued(deps: ServerDeps): Promise<number> {
  let started = 0;
  for (;;) {
    const slot = await acquireSlot(deps);
    if (!slot) return started;
    let jobId: string | null;
    try {
      jobId = await deps.store.claimNext(CRAWL_QUEUE);
    } catch (e) {
      await deps.store.releaseLease(slot.key, slot.token).catch(() => false);
      throw e;
    }
    if (!jobId) {
      await deps.store.releaseLease(slot.key, slot.token);
      return started;
    }
    deps.waitUntil(runInSlot(deps, jobId, slot));
    started++;
  }
}

/**
 * Runs one claimed job in its slot. The slot is released when the worker
 * finishes, whatever the outcome (including `busy` and `skipped`), and the next
 * queued job is dispatched. An unexpected error rejects after that, so the
 * runtime's waitUntil wrapper reports it.
 */
async function runInSlot(deps: ServerDeps, jobId: string, slot: Slot): Promise<WorkerOutcome> {
  let finished = false;
  const onFinish = async () => {
    if (finished) return;
    finished = true;
    await deps.store.releaseLease(slot.key, slot.token).catch(() => false);
    await dispatchQueued(deps).catch(() => 0);
  };
  try {
    const job = await getJob(deps.store, jobId);
    if (!job || job.status !== "queued" || isQueueExpired(job, deps.config, deps.clock())) return "skipped";
    return await runCrawl(jobId, { store: deps.store, config: deps.config, clock: deps.clock, fetch: deps.fetch, score: deps.score, onFinish });
  } finally {
    await onFinish();
  }
}
