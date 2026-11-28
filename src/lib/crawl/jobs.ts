import { randomBytes } from "node:crypto";
import { visitorTexts } from "../analysis/texts";
import type { Config } from "../config";
import type { Clock, Store } from "../store/types";

/**
 * A crawl job is shared, keyed by destination host. It is public data about a
 * public site and never holds visitor data.
 */
export type CrawlStatus = "queued" | "crawling" | "ready" | "failed" | "joined";

export interface CrawlFailure {
  readonly code: string;
  readonly message: string;
  readonly retryAt?: string;
}

export interface CrawlJob<TSnapshot = unknown, TScore = unknown> {
  readonly version: number;
  readonly id: string;
  readonly inputOrigin: string;
  readonly destinationHost?: string;
  readonly status: CrawlStatus;
  readonly step: string;
  readonly joinedTo?: string;
  readonly failure?: CrawlFailure;
  readonly snapshot?: TSnapshot;
  readonly score?: TScore;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** When the worker's lease ends unless renewed (ms since epoch). Set while crawling. */
  readonly leaseExpiresAt?: number;
  readonly queuedAt?: number;
  /** Set when a verified owner asked for the read: the owned hosts whose older ready read this job replaces. */
  readonly rereadHosts?: readonly string[];
}

export interface JobDeps {
  readonly store: Store;
  readonly config: Config;
  readonly clock: Clock;
}

interface Alias {
  readonly version: number;
  readonly jobId: string;
}

export const jobKey = (id: string) => `crawl-job:${id}`;
export const originAliasKey = (origin: string) => `crawl:origin:${origin}`;
export const destAliasKey = (host: string) => `crawl:dest:${host}`;
export const leaseKey = (id: string) => `crawl-lease:${id}`;

/** Jobs live long enough for a ready result to be cached and read. */
export function jobTtl(config: Config): number {
  return config.crawlCacheTtlS + config.staleAfterS + config.queueMaxWaitS;
}

export function newJobId(): string {
  return randomBytes(16).toString("hex");
}

export async function getJob<S, R>(store: Store, id: string): Promise<CrawlJob<S, R> | null> {
  return store.get<CrawlJob<S, R>>(jobKey(id));
}

/** Follows joins (at most 3 hops) to the job that holds the result. */
export async function resolveJob<S, R>(store: Store, id: string): Promise<CrawlJob<S, R> | null> {
  let job = await getJob<S, R>(store, id);
  for (let hops = 0; job?.status === "joined" && job.joinedTo && hops < 3; hops++) {
    job = await getJob<S, R>(store, job.joinedTo);
  }
  return job;
}

/** Writes a new version of a job if nobody else changed it. */
export async function updateJob<S, R>(
  deps: JobDeps,
  current: CrawlJob<S, R>,
  patch: Partial<Omit<CrawlJob<S, R>, "version" | "id">>,
): Promise<CrawlJob<S, R> | null> {
  const next: CrawlJob<S, R> = { ...current, ...patch, version: current.version + 1, updatedAt: deps.clock() };
  const ok = await deps.store.compareAndSet(jobKey(current.id), current, next, jobTtl(deps.config));
  return ok ? next : null;
}

/** True when the worker stopped: its lease ended and nothing was written for STALE_AFTER_S. */
export function isStale(job: CrawlJob, config: Config, now: number): boolean {
  if (job.status !== "crawling") return false;
  const leaseEnded = (job.leaseExpiresAt ?? 0) <= now;
  return leaseEnded && now - job.updatedAt > config.staleAfterS * 1000;
}

/** True when a queued job waited longer than QUEUE_MAX_WAIT_S without starting. */
export function isQueueExpired(job: CrawlJob, config: Config, now: number): boolean {
  return job.status === "queued" && now - (job.queuedAt ?? job.createdAt) > config.queueMaxWaitS * 1000;
}

/**
 * Reads a job and marks it failed when it is stale. Returns the current state.
 * With `followJoins: false` it makes exactly one read and returns a `joined`
 * job as it is, so the caller decides whether to follow it later.
 * When another reader wins the race to mark the job failed, the locally
 * computed failed state is returned without a second read.
 */
export async function readJobMarkingStale<S, R>(deps: JobDeps, id: string, o: { followJoins?: boolean } = {}): Promise<CrawlJob<S, R> | null> {
  const job = o.followJoins === false ? await getJob<S, R>(deps.store, id) : await resolveJob<S, R>(deps.store, id);
  if (!job) return null;
  const now = deps.clock();
  if (isStale(job, deps.config, now)) {
    const patch = {
      status: "failed",
      step: "failed",
      failure: { code: "stale", message: visitorTexts.stale },
      leaseExpiresAt: undefined,
    } as const;
    const failed = await updateJob(deps, job, patch);
    return failed ?? { ...job, ...patch };
  }
  return job;
}

function reusable(job: CrawlJob, config: Config, now: number): boolean {
  if (job.status === "ready") return now - job.updatedAt <= config.crawlCacheTtlS * 1000;
  if (job.status === "crawling") return !isStale(job, config, now);
  if (job.status === "queued") return !isQueueExpired(job, config, now);
  return false;
}

/** The youngest ready read that a verified owner may have replaced: at most one finished owner read an hour per host. */
export const OWNER_REREAD_S = 3600;

/** Seconds until a ready read may be replaced for its host's verified owner; never longer than the cache keeps it. */
export function ownerRereadS(config: Pick<Config, "crawlCacheTtlS">): number {
  return Math.min(OWNER_REREAD_S, config.crawlCacheTtlS);
}

/** True when the read is ready and old enough for its host's verified owner to ask for a new one. */
function rereadable(job: CrawlJob, config: Config, now: number): boolean {
  return job.status === "ready" && now - job.updatedAt >= ownerRereadS(config) * 1000;
}

export interface StartOptions {
  /**
   * The hosts of `hosts` that the requester is the verified owner of. Asked only when a job is created, or a
   * ready read is old enough to be replaced: an owner then gets a new read in place of the old one.
   */
  readonly ownedOf?: (hosts: readonly string[]) => Promise<readonly string[]>;
  /** Asked before a ready read is replaced for its owner; false keeps that read. */
  readonly mayReplace?: () => Promise<boolean>;
}

/** The hosts an address may lead to, as far as it is known before the crawl: itself, with or without `www.`, and where its last job led. */
function likelyHosts(inputOrigin: string, last: CrawlJob | null): string[] {
  const { host } = new URL(inputOrigin);
  const www = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  return [...new Set([host, www, ...(last?.destinationHost ? [last.destinationHost] : []), ...(last?.rereadHosts ?? [])])];
}

export interface StartResult {
  readonly jobId: string;
  /** True when this call created the job, so the caller must start or queue its worker. */
  readonly created: boolean;
}

/**
 * Returns a fresh ready job or a running job for this origin, or creates one.
 * The worker resolves the destination host in runCrawl.
 */
export async function startOrJoinCrawl(deps: JobDeps, inputOrigin: string, o: StartOptions = {}): Promise<StartResult> {
  const key = originAliasKey(inputOrigin);
  const ownedHosts = async (last: CrawlJob | null) => (await o.ownedOf?.(likelyHosts(inputOrigin, last))) ?? [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const now = deps.clock();
    const alias = await deps.store.get<Alias>(key);
    if (alias) {
      const job = await resolveJob(deps.store, alias.jobId);
      const live = job !== null && reusable(job, deps.config, now);
      if (live && !rereadable(job, deps.config, now)) return { jobId: job.id, created: false };
      const rereadHosts = await ownedHosts(job);
      if (live && !(rereadHosts.includes(job.destinationHost ?? "") && (await (o.mayReplace?.() ?? true)))) return { jobId: job.id, created: false };
      // Replace a failed, stale, expired or (for its owner) old job atomically. The new job is
      // written before the alias points at it, so no reader sees a missing job.
      const id = newJobId();
      await createJob(deps, id, inputOrigin, rereadHosts);
      if (await deps.store.compareAndSet(key, alias, { version: alias.version + 1, jobId: id }, deps.config.crawlCacheTtlS)) {
        return { jobId: id, created: true };
      }
      await deps.store.delete(jobKey(id));
      continue;
    }
    const id = newJobId();
    await createJob(deps, id, inputOrigin, await ownedHosts(null));
    const put = await deps.store.putIfAbsent<Alias>(key, { version: 1, jobId: id }, deps.config.crawlCacheTtlS);
    if (put.created) return { jobId: id, created: true };
    await deps.store.delete(jobKey(id));
  }
  throw new Error("startOrJoinCrawl: too much contention");
}

async function createJob(deps: JobDeps, id: string, inputOrigin: string, rereadHosts: readonly string[]): Promise<void> {
  const now = deps.clock();
  const job: CrawlJob = { version: 1, id, inputOrigin, status: "queued", step: "queued", createdAt: now, updatedAt: now, queuedAt: now, ...(rereadHosts.length > 0 ? { rereadHosts } : {}) };
  await deps.store.set(jobKey(id), job, jobTtl(deps.config));
}

/**
 * Claims the destination host for this job. Returns the id of another live job
 * that already owns it, or null when this job now owns it. `rereadHosts` (the job's own): an old ready
 * read of one of exactly these hosts does not own it any more.
 */
export async function claimDestination(deps: JobDeps, jobId: string, host: string, rereadHosts: readonly string[] = []): Promise<string | null> {
  const key = destAliasKey(host);
  for (let attempt = 0; attempt < 5; attempt++) {
    const put = await deps.store.putIfAbsent<Alias>(key, { version: 1, jobId }, deps.config.crawlCacheTtlS);
    if (put.created || put.value.jobId === jobId) return null;
    const other = await resolveJob(deps.store, put.value.jobId);
    const now = deps.clock();
    const replaced = other !== null && rereadHosts.includes(host) && rereadable(other, deps.config, now);
    if (other && other.id !== jobId && !replaced && reusable(other, deps.config, now)) return other.id;
    if (await deps.store.compareAndSet(key, put.value, { version: put.value.version + 1, jobId }, deps.config.crawlCacheTtlS)) return null;
  }
  throw new Error("claimDestination: too much contention");
}
