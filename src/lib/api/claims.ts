import { CLAIM_CHANGES_PER_HOUR, CLAIM_CHECKS_PER_HOUR } from "@/lib/accounts/limits";
import type { Account } from "@/lib/accounts/session";
import { claimPageUrl } from "@/lib/claims/host";
import { hostOfSource, parseClaimSource } from "@/lib/claims/sources";
import { CHECK_DEADLINE_MS, runClaimCheck } from "@/lib/claims/verify";
import { claimView } from "@/lib/claims/view";
import type { Claim, ClaimMethod } from "@/lib/accounts/data";
import { newToken, sha256Hex } from "@/lib/security/tokens";
import type { ServerDeps } from "@/lib/server/runtime";
import { CLAIMS_TEXT as T } from "@/lib/site/claims-texts";
import { accountPost, type Fields } from "./account-post";
import { json } from "./json";
import { countIn } from "./limits";

/**
 * The claim API behind the account page's claim panels (phase-3.md). Every route is an accountPost, for
 * a claim or source of the account (404 not_found). Answers carry `message` (CLAIMS_TEXT) and the claim as the page
 * shows it (claimView: never the token or its hash); the create and Start over answers also carry
 * the new token, the only time it is ever shown.
 */

type Deps = Pick<ServerDeps, "config" | "store" | "accounts" | "clock" | "fetch" | "txt" | "sleep">;

const CHECK_WINDOW = "claim-check";
const CHANGE_WINDOW = "claim-change";

const methodOf = (raw: unknown): ClaimMethod | null => (raw === "meta" || raw === "dns" ? raw : null);
const notFound = () => json(404, { error: "not_found", message: T.notFound });
const view = (deps: Deps, claim: Claim) => claimView(claim, deps.config);

/** The claim named by `fields.claimId` of the account, or a 404 response. */
async function ownClaim(deps: Deps, account: Account, fields: Fields): Promise<Claim | Response> {
  const claim = typeof fields.claimId === "string" ? await deps.accounts.getClaim(account.accountId, fields.claimId) : null;
  return claim ?? notFound();
}

/** 409 for a claim whose state refuses the action: verified (Start over) or superseded (terminal). */
const refused = (deps: Deps, claim: Claim) =>
  json(409, { error: claim.status, message: claim.status === "verified" ? T.verifiedNoRestart : T.supersededFinal, claim: view(deps, claim) });

/**
 * Counts one check of the account's claim for `host` (CLAIM_CHECKS_PER_HOUR per account and host, so
 * Remove and a new claim do not reset it). The window key is a hash, so the Store holds no host.
 */
const countCheck = (deps: Deps, account: Account, host: string) => countIn(deps, CHECK_WINDOW, CLAIM_CHECKS_PER_HOUR, sha256Hex(`${account.accountId}\n${host}`), T.limit);
/** Counts one claim creation or Start over of the account (CLAIM_CHANGES_PER_HOUR). */
const countChange = (deps: Deps, account: Account) => countIn(deps, CHANGE_WINDOW, CLAIM_CHANGES_PER_HOUR, account.accountId, T.changeLimit);

const guarded = (name: string, request: Request, deps: Deps, body: (account: Account, fields: Fields) => Promise<Response>) => accountPost(name, T, request, deps, body);

/**
 * POST /api/claims `{source, method}` -> 201 `{claim, token, message}`. `source` is `analysis:<id>`
 * (an analysis attached to the account) or `report:<id>` (a saved report); the claim is for that
 * analysis's or report's exact host. 400 invalid (no valid source or method) or not_public (the host
 * is not a public website), 404 not_found (not the account's), 409 exists or full (MAX_PENDING_CLAIMS),
 * 429 limit past CLAIM_CHANGES_PER_HOUR creations and Start overs of the account in the hour.
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
    const limited = await countChange(deps, account);
    if (limited) return limited;
    const token = newToken();
    const created = await deps.accounts.createClaim(account.accountId, { host, method, tokenHash: sha256Hex(token) });
    if (created.outcome === "full") return json(409, { error: "full", message: T.full });
    if (created.outcome === "exists") return json(409, { error: "exists", message: T.exists, claim: view(deps, created.claim) });
    return json(201, { claim: view(deps, created.claim), token, message: T.created });
  });
}

/**
 * POST /api/claims/check `{claimId}` -> 200 `{claim, message}`: Check again. Reads the home page or
 * the TXT record now and records what it found. 409 superseded (terminal: nothing is read), 429
 * limit `{retryAt}` past CLAIM_CHECKS_PER_HOUR checks of the account's claims for the host in the hour.
 */
export function handleCheckClaim(request: Request, deps: Deps): Promise<Response> {
  return guarded("/api/claims/check", request, deps, async (account, fields) => {
    const claim = await ownClaim(deps, account, fields);
    if (claim instanceof Response) return claim;
    if (claim.status === "superseded") return refused(deps, claim);
    const limited = await countCheck(deps, account, claim.host);
    if (limited) return limited;
    const { claim: after, checked } = await runClaimCheck(deps, claim, { notAfter: deps.clock() + CHECK_DEADLINE_MS, maxWaitMs: CHECK_DEADLINE_MS, onTimeout: "record" });
    const shown = view(deps, after);
    return json(200, { claim: shown, message: checked ? (shown.reason ?? shown.statusText) : T.notChecked });
  });
}

/**
 * POST /api/claims/start-over `{claimId, method?}` -> 200 `{claim, token, message}`: a new token (the
 * old one stops counting) and optionally the other method, back to pending. Counts as a change and a check. 409
 * verified or superseded (refused), 409 full (a lapsed claim would pass MAX_PENDING_CLAIMS), 429 limit.
 */
export function handleStartOverClaim(request: Request, deps: Deps): Promise<Response> {
  return guarded("/api/claims/start-over", request, deps, async (account, fields) => {
    const claim = await ownClaim(deps, account, fields);
    if (claim instanceof Response) return claim;
    const method = fields.method === undefined ? claim.method : methodOf(fields.method);
    if (!method) return json(400, { error: "invalid", message: T.invalid });
    if (claim.status === "verified" || claim.status === "superseded") return refused(deps, claim);
    const limited = (await countChange(deps, account)) ?? (await countCheck(deps, account, claim.host));
    if (limited) return limited;
    const token = newToken();
    const r = await deps.accounts.restartClaim(account.accountId, claim.id, { method, tokenHash: sha256Hex(token) });
    if (r.outcome === "restarted") return json(200, { claim: view(deps, r.claim), token, message: T.restarted });
    // A check or another tab changed the claim after it was read.
    if ("claim" in r) return refused(deps, r.claim);
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
