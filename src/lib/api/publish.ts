import { PUBLISH_PER_HOUR } from "@/lib/accounts/limits";
import { countClientWindow } from "@/lib/fetch/limits";
import { exactHost } from "@/lib/publish/host";
import { publishHost, type PublishHostDeps, type PublishHostResult } from "@/lib/publish/publish";
import { publishedView } from "@/lib/publish/view";
import { PUBLISH_TEXT as T } from "@/lib/site/publish-texts";
import { accountPost, type Fields } from "./account-post";
import { json, limitOr429 } from "./json";

/**
 * The publish API behind the account page's claim panels (phase-4.md). Every route is an accountPost
 * with `{host}` (400 invalid unless it is a host in its exact form). Answers carry `message`
 * (PUBLISH_TEXT) and, when the publication may have changed, `site`: the publication as the page shows
 * it (publishedView), or null when there is none.
 */

export type PublishDeps = PublishHostDeps;

const PUBLISH_WINDOW = "publish";

const hostOf = (fields: Fields): string | null => (typeof fields.host === "string" ? exactHost(fields.host) : null);
const invalid = () => json(400, { error: "invalid", message: T.invalid });
const noClaim = (host: string) => json(403, { error: "not_yours", message: T.noClaim(host) });
const notVerified = (host: string) => json(409, { error: "not_verified", message: T.notVerified(host) });

/** 422: the analysis itself cannot be published; 409: a newer (or any) analysis is needed. */
const FAILED_STATUS = { no_analysis: 409, not_newer: 409, generation_failed: 422, too_large: 422 } as const;

/**
 * POST /api/publish `{host}` -> 200 `{site, message}`: publishes the account's newest ready analysis of
 * the host, or refreshes the published copy. 403 not_yours without a claim by the account, 409
 * not_verified, 409 no_analysis or not_newer, 422 generation_failed or too_large (a published copy stays
 * as it was), 429 limit `{retryAt}` past PUBLISH_PER_HOUR publishes and refreshes of the account in the hour.
 */
export function handlePublish(request: Request, deps: PublishDeps): Promise<Response> {
  return accountPost("/api/publish", T, request, deps, async ({ accountId }, fields) => {
    const host = hostOf(fields);
    if (!host) return invalid();
    const claim = (await deps.accounts.listClaims(accountId)).find((c) => c.host === host);
    if (!claim) return noClaim(host);
    if (claim.status !== "verified") return notVerified(host);
    const limited = limitOr429(await countClientWindow(deps.store, PUBLISH_WINDOW, PUBLISH_PER_HOUR, accountId, deps.clock()), T.limit);
    if (limited) return limited;
    return answer(await publishHost(deps, accountId, host), host, deps);
  });
}

function answer(result: PublishHostResult, host: string, deps: PublishDeps): Response {
  switch (result.outcome) {
    case "published":
    case "refreshed":
      return json(200, { site: publishedView(result.site, deps.config), message: T[result.outcome] });
    // The claim changed after the first check: the write checks it again.
    case "no_claim":
      return noClaim(host);
    case "not_verified":
      return notVerified(host);
    default:
      return json(FAILED_STATUS[result.outcome], {
        error: result.outcome,
        message: T.refreshError[result.outcome](host),
        ...(result.site ? { site: publishedView(result.site, deps.config) } : {}),
      });
  }
}

/** POST /api/publish/remove `{host}` -> 200 `{site: null, message}`: unpublishes the account's own site, also a paused one. 404 not_found when the account publishes no such host. */
export function handleUnpublish(request: Request, deps: PublishDeps): Promise<Response> {
  return accountPost("/api/publish/remove", T, request, deps, async ({ accountId }, fields) => {
    const host = hostOf(fields);
    if (!host) return invalid();
    const removed = await deps.accounts.unpublishSite(accountId, host);
    return removed ? json(200, { site: null, message: T.unpublished }) : json(404, { error: "not_found", message: T.notPublished(host) });
  });
}
