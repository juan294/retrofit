import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import {
  claimDestination,
  getJob,
  jobKey,
  OWNER_REREAD_S,
  readJobMarkingStale,
  resolveJob,
  startOrJoinCrawl,
  updateJob,
  type JobDeps,
} from "@/lib/crawl/jobs";
import { createMemoryBacking, createMemoryStore } from "@/lib/store/memory";
import { jitter } from "../helpers/jitter-store";

function setup() {
  let now = Date.UTC(2026, 10, 15, 12);
  const clock = () => now;
  const backing = createMemoryBacking();
  const config = loadConfig({ SESSION_SECRET: "x".repeat(32), RETROFIT_TEST_FIXTURES: "1" });
  const a: JobDeps = { store: createMemoryStore({ clock, backing }), config, clock };
  const b: JobDeps = { store: createMemoryStore({ clock, backing }), config, clock };
  return { a, b, config, advance: (ms: number) => (now += ms), now: () => now };
}

describe("startOrJoinCrawl", () => {
  // Fails if the origin alias is not written with putIfAbsent (two jobs would be created).
  it("creates one job for ten concurrent calls on two instances", async () => {
    const { a, b } = setup();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => startOrJoinCrawl(i % 2 ? a : b, "https://bakery.example")));
    const ids = new Set(results.map((r) => r.jobId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  // Fails if the alias can point at a job that is not written yet (a second caller would replace it).
  it("creates one job when store operations interleave at random", async () => {
    for (let trial = 0; trial < 20; trial++) {
      const { a, b } = setup();
      const ja = { ...a, store: jitter(a.store) };
      const jb = { ...b, store: jitter(b.store) };
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => startOrJoinCrawl(i % 2 ? ja : jb, "https://bakery.example")));
      expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
    }
  });

  // Fails if a failed job is reused instead of replaced.
  it("replaces a failed job and reuses a fresh ready one", async () => {
    const { a, advance, config } = setup();
    const first = await startOrJoinCrawl(a, "https://bakery.example");
    const job = (await getJob(a.store, first.jobId))!;
    await updateJob(a, job, { status: "failed", failure: { code: "x", message: "x" } });
    const second = await startOrJoinCrawl(a, "https://bakery.example");
    expect(second.created).toBe(true);
    expect(second.jobId).not.toBe(first.jobId);

    const j2 = (await getJob(a.store, second.jobId))!;
    await updateJob(a, j2, { status: "ready" });
    expect(await startOrJoinCrawl(a, "https://bakery.example")).toEqual({ jobId: second.jobId, created: false });
    advance(config.crawlCacheTtlS * 1000 + 1000);
    expect((await startOrJoinCrawl(a, "https://bakery.example")).created).toBe(true);
  });
});

describe("claimDestination and joins", () => {
  // Fails if two input hosts that converge on one destination both crawl it.
  it("joins the second job to the first owner of the destination", async () => {
    const { a, b } = setup();
    const ja = await startOrJoinCrawl(a, "http://converge-a.fixture.test:1");
    const jb = await startOrJoinCrawl(b, "http://converge-b.fixture.test:1");
    const [ca, cb] = await Promise.all([claimDestination(a, ja.jobId, "dest.fixture.test"), claimDestination(b, jb.jobId, "dest.fixture.test")]);
    const owners = [ca, cb].filter((x) => x === null);
    expect(owners).toHaveLength(1);
    const joinerId = ca === null ? jb.jobId : ja.jobId;
    const ownerId = ca === null ? ja.jobId : jb.jobId;
    expect(ca ?? cb).toBe(ownerId);
    const joiner = (await getJob(a.store, joinerId))!;
    await updateJob(a, joiner, { status: "joined", joinedTo: ownerId });
    expect((await resolveJob(a.store, joinerId))!.id).toBe(ownerId);
  });
});

describe("a new read for a verified owner", () => {
  const ORIGIN = "https://bakery.example";
  const HOST = "bakery.example";
  const ownerOf = (...owned: string[]) => ({ ownedOf: async (hosts: readonly string[]) => hosts.filter((h) => owned.includes(h)) });
  const owner = ownerOf(HOST);

  /** A ready read of HOST, `ageS` seconds old. */
  async function readyRead(ageS: number) {
    const s = setup();
    const { jobId } = await startOrJoinCrawl(s.a, ORIGIN);
    expect(await claimDestination(s.a, jobId, HOST)).toBeNull();
    await updateJob(s.a, (await getJob(s.a.store, jobId))!, { status: "ready", destinationHost: HOST });
    s.advance(ageS * 1000);
    return { ...s, jobId };
  }

  // Fails if the owner still gets the cached read, or anybody else gets a new one.
  it("replaces a read one hour old for the owner of its host, and for nobody else", async () => {
    const { a, jobId } = await readyRead(OWNER_REREAD_S);
    expect(await startOrJoinCrawl(a, ORIGIN)).toEqual({ jobId, created: false });
    expect(await startOrJoinCrawl(a, ORIGIN, ownerOf("other.example"))).toEqual({ jobId, created: false });
    const next = await startOrJoinCrawl(a, ORIGIN, owner);
    expect(next.created).toBe(true);
    expect(next.jobId).not.toBe(jobId);
    expect((await getJob(a.store, next.jobId))?.rereadHosts).toContain(HOST);
  });

  // Fails if an owner can make Retrofit read a site more than once an hour, or the ownership is read when it cannot matter.
  it("keeps a younger read without asking who owns the host", async () => {
    const { a, jobId } = await readyRead(OWNER_REREAD_S - 1);
    let asked = 0;
    expect(await startOrJoinCrawl(a, ORIGIN, { ownedOf: async (hosts) => (asked++, hosts) })).toEqual({ jobId, created: false });
    expect(asked).toBe(0);
  });

  // Fails if ten owner requests at once start more than one crawl, or a running read is replaced.
  it("starts one new read for ten concurrent requests and joins it while it runs", async () => {
    const { a, b, advance } = await readyRead(OWNER_REREAD_S);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => startOrJoinCrawl(i % 2 ? a : b, ORIGIN, owner)));
    expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    await updateJob(a, (await getJob(a.store, results[0]!.jobId))!, { status: "crawling", destinationHost: HOST, leaseExpiresAt: a.clock() + 3 * OWNER_REREAD_S * 1000 });
    advance(2 * OWNER_REREAD_S * 1000);
    expect(await startOrJoinCrawl(a, ORIGIN, owner)).toEqual({ jobId: results[0]!.jobId, created: false });
  });

  // Fails if the new read joins the old one at its destination, so that the owner gets the old snapshot again.
  it("takes over the destination it was started for", async () => {
    const { a, jobId } = await readyRead(OWNER_REREAD_S);
    const next = await startOrJoinCrawl(a, ORIGIN, owner);
    expect(await claimDestination(a, next.jobId, HOST, [HOST])).toBeNull();
    const later = await startOrJoinCrawl(a, "https://alias.example");
    expect(await claimDestination(a, later.jobId, HOST)).toBe(next.jobId);
    expect(next.jobId).not.toBe(jobId);
  });

  /** The worker's claim of the destination, with the job's own rereadHosts. */
  const claim = async (d: JobDeps, jobId: string, host: string) => claimDestination(d, jobId, host, (await getJob(d.store, jobId))!.rereadHosts);

  // Fails if the owner's retry after a failed new read joins the old read again.
  it("a retry after a failed new read still replaces the old one", async () => {
    const { a } = await readyRead(OWNER_REREAD_S);
    const failed = await startOrJoinCrawl(a, ORIGIN, owner);
    await updateJob(a, (await getJob(a.store, failed.jobId))!, { status: "failed", failure: { code: "crawl_error", message: "x" } });
    const retry = await startOrJoinCrawl(a, ORIGIN, owner);
    expect(retry.created).toBe(true);
    expect(await claim(a, retry.jobId, HOST)).toBeNull();
  });

  // Fails if the owner gets the old read from another address of the site that was never analyzed, or anybody else gets a new one there.
  it.each(["http://bakery.example", "https://www.bakery.example"])("replaces the old read from the new address %s, for the owner only", async (address) => {
    const { a, jobId } = await readyRead(OWNER_REREAD_S);
    const own = await startOrJoinCrawl(a, address, owner);
    const other = await startOrJoinCrawl(a, `${address}:8080`);
    expect(await claim(a, other.jobId, HOST)).toBe(jobId);
    expect(await claim(a, own.jobId, HOST)).toBeNull();
  });

  // Fails if an owner's retry keeps a right that the account lost in between.
  it("asks again who owns the host on a retry", async () => {
    const { a, jobId } = await readyRead(OWNER_REREAD_S);
    const failed = await startOrJoinCrawl(a, ORIGIN, owner);
    await updateJob(a, (await getJob(a.store, failed.jobId))!, { status: "failed", failure: { code: "crawl_error", message: "x" } });
    const retry = await startOrJoinCrawl(a, ORIGIN, ownerOf());
    expect(await claim(a, retry.jobId, HOST)).toBe(jobId);
  });

  // Fails if a retry forgets the host that a redirecting address led to.
  it("a retry keeps the host a redirecting address led to", async () => {
    const { a, jobId } = await readyRead(OWNER_REREAD_S);
    const address = "https://short.example";
    const joined = await startOrJoinCrawl(a, address);
    await updateJob(a, (await getJob(a.store, joined.jobId))!, { status: "joined", joinedTo: jobId });
    const failed = await startOrJoinCrawl(a, address, owner);
    expect(failed.created).toBe(true);
    await updateJob(a, (await getJob(a.store, failed.jobId))!, { status: "failed", failure: { code: "crawl_error", message: "x" } });
    const retry = await startOrJoinCrawl(a, address, owner);
    expect(await claim(a, retry.jobId, HOST)).toBeNull();
  });

  // Fails if the cached read is dropped although its replacement may not start (the daily host cap).
  it("keeps the cached read when a new one may not start", async () => {
    const { a, jobId } = await readyRead(OWNER_REREAD_S);
    expect(await startOrJoinCrawl(a, ORIGIN, { ...owner, mayReplace: async () => false })).toEqual({ jobId, created: false });
  });

  // Fails if a redirect lets an owner of one host replace the read of another host.
  it("joins the read of another host that the site redirects to now", async () => {
    const { a } = await readyRead(OWNER_REREAD_S);
    const other = await startOrJoinCrawl(a, "https://other.example");
    expect(await claimDestination(a, other.jobId, "other.example")).toBeNull();
    await updateJob(a, (await getJob(a.store, other.jobId))!, { status: "ready", destinationHost: "other.example" });
    const old = (await getJob(a.store, other.jobId))!;
    await a.store.set(jobKey(old.id), { ...old, updatedAt: old.updatedAt - OWNER_REREAD_S * 1000 }, 3600);
    const next = await startOrJoinCrawl(a, ORIGIN, owner);
    expect(await claimDestination(a, next.jobId, "other.example", [HOST])).toBe(other.jobId);
  });

  // Fails if two addresses of one site let its owner read it twice in an hour.
  it("joins a younger read of the same host from another address", async () => {
    const { a } = await readyRead(OWNER_REREAD_S);
    const http = await startOrJoinCrawl(a, "http://bakery.example");
    await updateJob(a, (await getJob(a.store, http.jobId))!, { status: "joined", joinedTo: (await startOrJoinCrawl(a, ORIGIN)).jobId });
    const first = await startOrJoinCrawl(a, ORIGIN, owner);
    expect(await claimDestination(a, first.jobId, HOST, [HOST])).toBeNull();
    await updateJob(a, (await getJob(a.store, first.jobId))!, { status: "ready", destinationHost: HOST });
    const second = await startOrJoinCrawl(a, "http://bakery.example", owner);
    expect(await claimDestination(a, second.jobId, HOST, [HOST])).toBe(first.jobId);
  });
});

describe("stale jobs and fencing", () => {
  // Fails if the stale rule ignores updatedAt (89 s) or the lease (91 s).
  it("marks a crawling job failed only after the lease ended and 90 s passed", async () => {
    const { a, advance } = setup();
    const { jobId } = await startOrJoinCrawl(a, "https://bakery.example");
    const job = (await getJob(a.store, jobId))!;
    await updateJob(a, job, { status: "crawling", leaseExpiresAt: a.clock() + 60_000 });
    advance(89_000);
    expect((await readJobMarkingStale(a, jobId))!.status).toBe("crawling");
    advance(2_000);
    const read = (await readJobMarkingStale(a, jobId))!;
    expect(read.status).toBe("failed");
    expect(read.failure?.code).toBe("stale");
  });

  // Fails if a worker could overwrite a newer job state (no compare-and-set on version).
  it("discards a late completion after a stale failure", async () => {
    const { a, b, advance } = setup();
    const { jobId } = await startOrJoinCrawl(a, "https://bakery.example");
    const workerView = (await updateJob(a, (await getJob(a.store, jobId))!, { status: "crawling", leaseExpiresAt: a.clock() + 60_000 }))!;
    advance(91_000);
    expect((await readJobMarkingStale(b, jobId))!.status).toBe("failed");
    expect(await updateJob(a, workerView, { status: "ready" })).toBeNull();
    expect((await getJob(a.store, jobId))!.status).toBe("failed");
  });
});
