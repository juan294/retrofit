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
  const decision = await countOnce(deps.store, `crawl-origin-day:${day}:${shortHash(inputOrigin)}`, `crawl-origins:${day}`, ttl, deps.config.crawlMaxHostsPerDay);
  // `undecided` (another job of this origin is still being counted today) starts the crawl. That
  // other decision usually counts the origin; when its caller was refused or stopped before
  // counting, this crawl runs uncounted, so at most one extra crawl per pending marker passes a
  // full cap. Refusing would tell the visitor the daily limit was reached when it may not have been.
  if (decision === "refused") {
    const job = await getJob(deps.store, jobId);
    if (job) await updateJob(deps, job, { status: "failed", step: "failed", failure: { code: "daily_limit", message: visitorTexts.dailyLimit } });
    return { ok: false, code: "daily_limit", retryAt: midnight };
  }
  await deps.store.enqueue(CRAWL_QUEUE, jobId, deps.config.queueMaxWaitS);
  return { ok: true, jobId, created };
}

/** The routes' `maxDuration` (seconds). Route files repeat the literal 60, which Next.js needs statically. */
export const MAX_DURATION_S = 60;
/** Time kept free after a crawl's budget, for the final writes and the response. */
export const START_MARGIN_MS = 10_000;

/** The function invocation that runs a dispatch; background work started in it ends with it. */
export interface Invocation {
  /** When the request that started this invocation arrived (deps.clock()). */
  readonly startedAt: number;
}

/**
 * True when this invocation has time left for a whole crawl: elapsed time plus
 * CRAWL_BUDGET_MS plus START_MARGIN_MS fits in MAX_DURATION_S. A worker that
 * finishes late in its invocation therefore leaves the next job queued for the
 * next request's own dispatch.
 */
export function hasTimeForCrawl(deps: Pick<ServerDeps, "config" | "clock">, invocation: Invocation): boolean {
  return deps.clock() - invocation.startedAt + deps.config.crawlBudgetMs + START_MARGIN_MS <= MAX_DURATION_S * 1000;
}

/**
 * Starts queued jobs while slots, queued jobs and invocation time remain
 * (phase-3.md `dispatchQueued`). Called at the end of every worker run (with
 * that worker's invocation) and on every analyze and score request and every
 * owner's status request. Returns the number of workers emitted.
 *
 * Each round is one Store.claimWithLease call (one RPC on Supabase): it takes
 * the oldest queued job together with the first free slot, or changes nothing
 * when the queue is empty or every slot is held. So a dispatch with nothing to
 * start costs one store operation.
 *
 * Each emitted worker first checks its job: a job that is no longer queued or
 * whose queue time passed is skipped, its slot released and dispatch repeated
 * (the pseudo-code's "fail" line). The check runs inside the worker task, so a
 * request that dispatches makes no extra job read of its own.
 */
export async function dispatchQueued(deps: ServerDeps, invocation: Invocation): Promise<number> {
  // Every slot's lease key, in order (built once per dispatch).
  const slotKeys = Array.from({ length: deps.config.crawlMaxConcurrent }, (_, n) => slotKey(n));
  let started = 0;
  for (;;) {
    if (!hasTimeForCrawl(deps, invocation)) return started;
    const claim = await deps.store.claimWithLease(CRAWL_QUEUE, slotKeys, deps.config.crawlLeaseTtlS);
    if (!claim) return started;
    deps.waitUntil(runInSlot(deps, claim.itemId, { key: claim.leaseKey, token: claim.token }, invocation));
    started++;
  }
}

/**
 * Runs one claimed job in its slot. The slot lease is renewed every third of
 * its TTL while the worker runs, and released when the worker finishes,
 * whatever the outcome (including `busy` and `skipped`); then the next queued
 * job is dispatched if this invocation has time for it. An unexpected error
 * rejects after that, so the runtime's waitUntil wrapper reports it.
 */
async function runInSlot(deps: ServerDeps, jobId: string, slot: Slot, invocation: Invocation): Promise<WorkerOutcome> {
  const ttl = deps.config.crawlLeaseTtlS;
  const heartbeat = setInterval(() => {
    deps.store.renewLease(slot.key, slot.token, ttl).catch(() => false);
  }, Math.max(1, Math.floor((ttl * 1000) / 3)));
  let finished = false;
  const onFinish = async () => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    await deps.store.releaseLease(slot.key, slot.token).catch(() => false);
    if (hasTimeForCrawl(deps, invocation) || !deps.kick) await dispatchQueued(deps, invocation).catch(() => 0);
    // Too little time left here: a fresh invocation dispatches the next job, so a queued
    // job does not wait for the next visitor or agent request.
    else await deps.kick().catch(() => undefined);
  };
  try {
    const job = await getJob(deps.store, jobId);
    if (!job || job.status !== "queued" || isQueueExpired(job, deps.config, deps.clock())) return "skipped";
    return await runCrawl(jobId, { store: deps.store, config: deps.config, clock: deps.clock, fetch: deps.fetch, score: deps.score, onFinish });
  } finally {
    clearInterval(heartbeat);
    await onFinish();
  }
}
