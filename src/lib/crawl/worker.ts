import { visitorTexts } from "../analysis/texts";
import { NotPublicError, RobotsBlocked, RobotsUnavailable } from "../fetch/errors";
import { crawlSite, LeaseLost } from "../fetch/crawl";
import type { FetchContext } from "../fetch/http";
import type { Snapshot } from "../snapshot/types";
import { claimDestination, getJob, leaseKey, updateJob, type CrawlFailure, type CrawlJob, type JobDeps } from "./jobs";

export interface WorkerDeps<R = unknown> extends JobDeps {
  readonly fetch: FetchContext;
  /** Computes the score stored on a ready job (Phase 3). */
  readonly score?: (snapshot: Snapshot) => R;
  /** Runs after the worker finishes, whatever the outcome (Phase 3 dispatches queued jobs here). */
  readonly onFinish?: () => Promise<void>;
}

export type WorkerOutcome = "ready" | "failed" | "joined" | "lease-lost" | "busy" | "skipped";

export function failureFor(e: unknown): CrawlFailure {
  if (e instanceof RobotsBlocked) return { code: "robots_blocked", message: visitorTexts.robotsBlocked };
  if (e instanceof RobotsUnavailable) return { code: "robots_unavailable", message: "Retrofit could not read this site's robots rules, so it stopped.", retryAt: e.retryAt.toISOString() };
  if (e instanceof NotPublicError) return { code: "not_public", message: visitorTexts.notPublic };
  return { code: "crawl_error", message: visitorTexts.crawlError };
}

/**
 * Runs one crawl job under a lease. Every write is fenced: it happens only
 * while this worker's lease token is valid and the job version is the one
 * this worker last wrote.
 */
export async function runCrawl<R>(jobId: string, deps: WorkerDeps<R>): Promise<WorkerOutcome> {
  const ttl = deps.config.crawlLeaseTtlS;
  const key = leaseKey(jobId);
  let token: string | null = null;
  try {
    token = await deps.store.acquireLease(key, ttl);
    if (!token) return "busy";
    const owned = token;
    const initial = await getJob<Snapshot, R>(deps.store, jobId);
    if (!initial || (initial.status !== "queued" && initial.status !== "crawling")) return "skipped";
    let job: CrawlJob<Snapshot, R> | null = await updateJob(deps, initial, { status: "crawling", step: "home", leaseExpiresAt: deps.clock() + ttl * 1000 });
    if (!job) return "lease-lost";

    /** Renews the lease and records progress; false when this worker no longer owns the job. */
    const write = async (patch: Partial<CrawlJob<Snapshot, R>>): Promise<boolean> => {
      if (!job || !(await deps.store.renewLease(key, owned, ttl))) return false;
      job = await updateJob(deps, job, { leaseExpiresAt: deps.clock() + ttl * 1000, ...patch });
      return job !== null;
    };

    let joinedTo: string | null = null;
    try {
      const snapshot = await crawlSite(initial.inputOrigin, {
        config: deps.config,
        fetch: deps.fetch,
        clock: deps.clock,
        hooks: {
          afterHome: async (host) => {
            // Prove the lease is still ours before touching the shared destination alias.
            if (!(await write({ step: "claim" }))) throw new LeaseLost();
            joinedTo = await claimDestination(deps, jobId, host, initial.rereadHosts);
            if (joinedTo) return false;
            if (!(await write({ destinationHost: host, step: "probes" }))) throw new LeaseLost();
            return true;
          },
          progress: (step) => write({ step }),
        },
      });
      if (!snapshot) {
        return (await write({ status: "joined", joinedTo: joinedTo ?? undefined, step: "joined", leaseExpiresAt: undefined })) ? "joined" : "lease-lost";
      }
      const score = deps.score?.(snapshot);
      return (await write({ status: "ready", step: "ready", snapshot, score, leaseExpiresAt: undefined })) ? "ready" : "lease-lost";
    } catch (e) {
      if (e instanceof LeaseLost) return "lease-lost";
      return (await write({ status: "failed", step: "failed", failure: failureFor(e), leaseExpiresAt: undefined })) ? "failed" : "lease-lost";
    }
  } finally {
    if (token) await deps.store.releaseLease(key, token);
    await deps.onFinish?.();
  }
}
