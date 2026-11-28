import { randomBytes } from "node:crypto";
import type { Claim } from "@/lib/accounts/data";
import { CLAIM_LAPSE_AFTER } from "@/lib/accounts/limits";
import { addAccountAnalyses } from "@/lib/analysis/account-list";
import { accountListTtl, analysisKey, EXPIRED_GRACE_S, storeTtl, type Analysis } from "@/lib/analysis/record";
import { scoreSnapshot } from "@/lib/score/score";
import { sha256Hex } from "@/lib/security/tokens";
import { agentSnapshot, type Snapshot } from "@/lib/snapshot/types";
import { networkNameFor } from "@/lib/generate/network";
import { BRIDGE_RUNTIME_FILES } from "@/lib/publish/assets";
import { storeAnalysis, testDeps, TEST_ACCOUNT, type TestDeps } from "../helpers/server-deps";

export { snapshotOf } from "../helpers/agent-snapshot";

export const HOST = "shop.example.com";
export const OWNER: string = TEST_ACCOUNT.userId;

/**
 * Stores a ready analysis of `snapshot` (or, without one, an analysis whose crawl never finished) attached to
 * `accountId` and in that account's list, as a signed-in visitor's analysis is. `listedHost`: the list entry's host.
 */
export async function listedAnalysis(
  d: TestDeps,
  o: { snapshot?: Snapshot; accountId?: string; inputOrigin?: string; listedHost?: string; over?: Partial<Analysis> },
): Promise<Analysis> {
  const accountId = o.accountId ?? OWNER;
  const inputOrigin = o.inputOrigin ?? `https://${o.snapshot?.host ?? HOST}`;
  const ready = o.snapshot ? { snapshot: o.snapshot, score: scoreSnapshot(o.snapshot), readyAt: Date.parse(o.snapshot.fetchedAt) } : {};
  const a = await storeAnalysis(d, { id: randomBytes(16).toString("hex"), inputOrigin, accountId, expiresAt: d.clock() + d.config.analysisTtlS * 1000, ...ready, ...o.over });
  // As storeTtl: the record outlives the analysis, so a test may move its clock by days.
  await d.store.set(analysisKey(a.id), a, storeTtl(a, d.clock()));
  await addAccountAnalyses(d.store, accountId, [{ id: a.id, host: o.listedHost ?? new URL(inputOrigin).host, keptUntil: a.expiresAt + EXPIRED_GRACE_S * 1000 }], accountListTtl(d.config));
  return a;
}

const tokenHashOf = (accountId: string, host: string) => sha256Hex(`${accountId}-${host}`);

/** The account's claim for the host, created pending. */
export async function pendingClaim(d: TestDeps, accountId = OWNER, host = HOST): Promise<Claim> {
  const r = await d.accounts.createClaim(accountId, { host, method: "dns", tokenHash: tokenHashOf(accountId, host) });
  if (r.outcome === "full") throw new Error("full");
  return r.claim;
}

/** One passed check of the claim, now. */
export async function verifyNow(d: TestDeps, claim: Claim): Promise<void> {
  const r = await d.accounts.verifyClaim(claim.id, { tokenHash: claim.tokenHash, checkedAt: new Date(d.clock()).toISOString() });
  if (r.outcome !== "verified") throw new Error(r.outcome);
}

export async function verifiedClaim(d: TestDeps, accountId = OWNER, host = HOST): Promise<Claim> {
  const claim = await pendingClaim(d, accountId, host);
  await verifyNow(d, claim);
  return claim;
}

/** Enough failed checks to lapse a verified claim. */
export async function lapseNow(d: TestDeps, claim: Claim): Promise<void> {
  for (let n = 0; n < CLAIM_LAPSE_AFTER; n++) {
    await d.accounts.recordClaimFailure(claim.id, { tokenHash: claim.tokenHash, result: "record_missing", detail: null, checkedAt: new Date(d.clock()).toISOString() });
  }
}

/** Writes a publication directly, in its stored form (the owner must hold a verified claim). */
export async function publishDirect(d: TestDeps, snapshot: Snapshot, o: { accountId?: string; score?: number | null } = {}): Promise<void> {
  const report = { ...scoreSnapshot(snapshot), ...(o.score === undefined ? {} : { score: o.score }) };
  const r = await d.accounts.publishSite(o.accountId ?? OWNER, {
    host: snapshot.host,
    snapshot: agentSnapshot(snapshot),
    report: report as unknown as Record<string, unknown>,
    fetchedAt: snapshot.fetchedAt,
    now: new Date(d.clock()).toISOString(),
  });
  if (!("site" in r)) throw new Error(r.outcome);
}

/** New deps with `snapshot`'s host claimed, verified and published (with `score` in place of the snapshot's own, when given). */
export async function published(snapshot: Snapshot, score?: number | null): Promise<{ d: TestDeps; claim: Claim }> {
  const d = testDeps();
  const claim = await verifiedClaim(d, undefined, snapshot.host);
  await publishDirect(d, snapshot, { score });
  return { d, claim };
}

const JSON_TYPE = "application/json";
const JS_TYPE = "text/javascript; charset=utf-8";

/** Every file of a published host, with its content type. */
export const publishedFiles = (host: string): [file: string, type: string][] => [
  ["agent-manifest.json", JSON_TYPE],
  [`${networkNameFor(host)}.network.json`, JSON_TYPE],
  ["site-content.json", JSON_TYPE],
  ["links.json", JSON_TYPE],
  ["bridge/agent-manifest.json", JSON_TYPE],
  ["content-actions.js", JS_TYPE],
  ["bridge/action-bridge.html", "text/html; charset=utf-8"],
  ...BRIDGE_RUNTIME_FILES.map((f): [string, string] => [`runtime/${f}`, JS_TYPE]),
];
