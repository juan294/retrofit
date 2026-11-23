import { CLAIM_CHECKS_PER_HOUR } from "@/lib/accounts/limits";
import { readAccount, type Account } from "@/lib/accounts/session";
import { isSameOrigin } from "@/lib/analysis/run";
import { claimPageUrl, newClaimToken } from "@/lib/claims/host";
import { hostOfSource, parseClaimSource } from "@/lib/claims/sources";
import { runClaimCheck } from "@/lib/claims/verify";
import { claimView } from "@/lib/claims/view";
import type { Claim, ClaimMethod } from "@/lib/accounts/data";
import { countClientWindow } from "@/lib/fetch/limits";
import { sha256Hex } from "@/lib/security/tokens";
import type { ServerDeps } from "@/lib/server/runtime";
import { CLAIMS_TEXT as T } from "@/lib/site/claims-texts";
import { readSmallBody } from "./body";
import { json } from "./json";

/**
 * The claim API behind the account page's claim panels (phase-3.md). Every route: POST, same-origin
 * only (403 cross_origin), a JSON body of at most 2 KB (413 too_large), a signed-in account (401
 * signed_out), and a claim or source of that account (404 not_found). 503 unavailable when the
 * account data or the Store fails. Answers carry `message` (CLAIMS_TEXT) and the claim as the page
 * shows it (claimView: never the token or its hash); the create and Start over answers also carry
 * the new token, the only time it is ever shown.
 */

type Deps = Pick<ServerDeps, "config" | "store" | "accounts" | "clock" | "fetch" | "txt">;

/** A check (Check again or Start over) may start requests for this long; a route invocation has 60 s. */
export const CHECK_DEADLINE_MS = 20_000;
const CHECK_WINDOW = "claim-check";

type Fields = Record<string, unknown>;

/** The shared preconditions; a Response when one fails. */
async function claimRequest(request: Request, deps: Deps): Promise<{ account: Account; fields: Fields } | Response> {
  if (!isSameOrigin(request, deps.config)) return json(403, { error: "cross_origin", message: T.crossOrigin });
  const text = await readSmallBody(request);
  if (text === "too large") return json(413, { error: "too_large", message: T.tooLarge });
  let fields: Fields = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) fields = parsed as Fields;
  } catch {
    fields = {};
  }
  const account = await readAccount(request, deps);
  if (!account) return json(401, { error: "signed_out", message: T.signedOut });
  return { account, fields };
}

const methodOf = (raw: unknown): ClaimMethod | null => (raw === "meta" || raw === "dns" ? raw : null);
const notFound = () => json(404, { error: "not_found", message: T.notFound });
const view = (deps: Deps, claim: Claim) => claimView(claim, deps.config);

/** The claim named by `fields.claimId` of the account, or a 404 response. */
async function ownClaim(deps: Deps, account: Account, fields: Fields): Promise<Claim | Response> {
  const claim = typeof fields.claimId === "string" ? await deps.accounts.getClaim(account.accountId, fields.claimId) : null;
  return claim ?? notFound();
}

/** Counts one check of the claim (CLAIM_CHECKS_PER_HOUR per hour); a 429 response past it. */
async function countCheck(deps: Deps, claimId: string): Promise<Response | null> {
  const counted = await countClientWindow(deps.store, CHECK_WINDOW, CLAIM_CHECKS_PER_HOUR, claimId, deps.clock());
  if (counted.ok) return null;
  const retryAt = new Date(counted.retryAt);
  return json(429, { error: "limit", message: T.limit(retryAt), retryAt: retryAt.toISOString() });
}

async function guarded(name: string, request: Request, deps: Deps, body: (account: Account, fields: Fields) => Promise<Response>): Promise<Response> {
  try {
    const pre = await claimRequest(request, deps);
    if (pre instanceof Response) return pre;
    return await body(pre.account, pre.fields);
  } catch (e) {
    console.error(`POST ${name} failed:`, e instanceof Error ? e.name : "unknown error");
    return json(503, { error: "unavailable", message: T.unavailable });
  }
}

/**
 * POST /api/claims `{source, method}` -> 201 `{claim, token, message}`. `source` is `analysis:<id>`
 * (an analysis attached to the account) or `report:<id>` (a saved report); the claim is for that
 * analysis's or report's exact host. 400 invalid (no valid source or method) or not_public (the host
 * is not a public website), 404 not_found (not the account's), 409 exists or full (MAX_PENDING_CLAIMS).
 */
export function handleCreateClaim(request: Request, deps: Deps): Promise<Response> {
  return guarded("/api/claims", request, deps, async (account, fields) => {
    const source = parseClaimSource(fields.source);
    const method = methodOf(fields.method);
    if (!source || !method) return json(400, { error: "invalid", message: T.invalid });
    const host = await hostOfSource(deps, account.accountId, source);
    if (!host) return notFound();
    try {
      claimPageUrl(host, deps.config);
    } catch {
      return json(400, { error: "not_public", message: T.notPublic });
    }
    const token = newClaimToken(host, deps.config);
    const created = await deps.accounts.createClaim(account.accountId, { host, method, tokenHash: sha256Hex(token) });
    if (created.outcome === "full") return json(409, { error: "full", message: T.full });
    if (created.outcome === "exists") return json(409, { error: "exists", message: T.exists, claim: view(deps, created.claim) });
    return json(201, { claim: view(deps, created.claim), token, message: T.created });
  });
}

/**
 * POST /api/claims/check `{claimId}` -> 200 `{claim, message}`: Check again. Reads the home page or
 * the TXT record now and records what it found. 409 superseded (terminal: nothing is read), 429
 * limit `{retryAt}` past CLAIM_CHECKS_PER_HOUR checks of the claim in the hour.
 */
export function handleCheckClaim(request: Request, deps: Deps): Promise<Response> {
  return guarded("/api/claims/check", request, deps, async (account, fields) => {
    const claim = await ownClaim(deps, account, fields);
    if (claim instanceof Response) return claim;
    if (claim.status === "superseded") return json(409, { error: "superseded", message: T.supersededFinal, claim: view(deps, claim) });
    const limited = await countCheck(deps, claim.id);
    if (limited) return limited;
    const { claim: after, checked } = await runClaimCheck(deps, claim, { notAfter: deps.clock() + CHECK_DEADLINE_MS });
    const shown = view(deps, after);
    return json(200, { claim: shown, message: checked ? (shown.reason ?? shown.statusText) : T.notChecked });
  });
}

/**
 * POST /api/claims/start-over `{claimId, method?}` -> 200 `{claim, token, message}`: a new token (the
 * old one stops counting) and optionally the other method, back to pending. Counts as a check. 409
 * verified or superseded (refused), 409 full (a lapsed claim would pass MAX_PENDING_CLAIMS), 429 limit.
 */
export function handleStartOverClaim(request: Request, deps: Deps): Promise<Response> {
  return guarded("/api/claims/start-over", request, deps, async (account, fields) => {
    const claim = await ownClaim(deps, account, fields);
    if (claim instanceof Response) return claim;
    const method = fields.method === undefined ? claim.method : methodOf(fields.method);
    if (!method) return json(400, { error: "invalid", message: T.invalid });
    if (claim.status === "verified") return json(409, { error: "verified", message: T.verifiedNoRestart, claim: view(deps, claim) });
    if (claim.status === "superseded") return json(409, { error: "superseded", message: T.supersededFinal, claim: view(deps, claim) });
    const limited = await countCheck(deps, claim.id);
    if (limited) return limited;
    const token = newClaimToken(claim.host, deps.config);
    const r = await deps.accounts.restartClaim(account.accountId, claim.id, { method, tokenHash: sha256Hex(token) });
    if (r.outcome === "restarted") return json(200, { claim: view(deps, r.claim), token, message: T.restarted });
    // A check or another tab changed the claim after it was read.
    if ("claim" in r) return json(409, { error: r.outcome, message: r.outcome === "verified" ? T.verifiedNoRestart : T.supersededFinal, claim: view(deps, r.claim) });
    return r.outcome === "missing" ? notFound() : json(409, { error: "full", message: T.full });
  });
}

/** POST /api/claims/remove `{claimId}` -> 200 `{removed: true, message}`: withdraws the claim (a published site of it goes too). */
export function handleRemoveClaim(request: Request, deps: Deps): Promise<Response> {
  return guarded("/api/claims/remove", request, deps, async (account, fields) => {
    const removed = typeof fields.claimId === "string" && (await deps.accounts.deleteClaim(account.accountId, fields.claimId));
    return removed ? json(200, { removed: true, message: T.removed }) : notFound();
  });
}
