import { PUBLISH_PER_HOUR, PUBLISH_TRIES_PER_HOUR } from "@/lib/accounts/limits";
import { exactHost } from "@/lib/publish/host";
import { isPublished, newReadFrom, publishHost, publishSource, type PublishHostDeps, type PublishSource } from "@/lib/publish/publish";
import { publishedView } from "@/lib/publish/view";
import { PUBLISH_TEXT as T } from "@/lib/site/publish-texts";
import { accountPost, type Fields } from "./account-post";
import { refuseFeature } from "./entitled";
import { json } from "./json";
import { countIn } from "./limits";

/**
 * The publish API behind the account page's claim panels (phase-4.md). Every route is an accountPost
 * with `{host}` (400 invalid unless it is a host in its exact form). Answers carry `message`
 * (PUBLISH_TEXT) and, when the publication may have changed, `site`: the publication as the page shows
 * it (publishedView), or null when there is none.
 */

export type PublishDeps = PublishHostDeps;

const PUBLISH_WINDOW = "publish";
const TRY_WINDOW = "publish-try";

const hostOf = (fields: Fields): string | null => (typeof fields.host === "string" ? exactHost(fields.host) : null);
const invalid = () => json(400, { error: "invalid", message: T.invalid });
const noClaim = (host: string) => json(403, { error: "not_yours", message: T.noClaim(host) });
const notVerified = (host: string) => json(409, { error: "not_verified", message: T.notVerified(host) });

/** 422: the analysis itself cannot be published; 409: an analysis is needed first. */
const FAILED_STATUS = { no_analysis: 409, generation_failed: 422, too_large: 422 } as const;

/**
 * POST /api/publish `{host}` -> 200 `{site, message}`: publishes the account's newest ready analysis of
 * the host, or refreshes the published copy. 403 not_yours without a claim by the account, 409
 * not_verified, 403 plan_required or 503 billing_unavailable (entitled.ts; from BILLING_START a page
 * already published stays public without a plan, and Unpublish needs none), 409 no_analysis, 422 generation_failed or too_large (a published copy stays as it was),
 * 409 not_newer (no newer read than the published one: not counted and not a failed refresh; `retryAt` is when
 * a new read of the site is possible, when that is still to come), 429 limit `{retryAt}` past PUBLISH_PER_HOUR
 * publishes and refreshes, or PUBLISH_TRIES_PER_HOUR tries, of the account in the hour.
 */
export function handlePublish(request: Request, deps: PublishDeps): Promise<Response> {
  return accountPost("/api/publish", T, request, deps, async ({ accountId }, fields) => {
    const host = hostOf(fields);
    if (!host) return invalid();
    const claim = (await deps.accounts.listClaims(accountId)).find((c) => c.host === host);
    if (!claim) return noClaim(host);
    if (claim.status !== "verified") return notVerified(host);
    const refused = await refuseFeature(deps, accountId, "publish");
    if (refused) return refused;
    // Counted before the account's analyses are read.
    const tooMany = await countIn(deps, TRY_WINDOW, PUBLISH_TRIES_PER_HOUR, accountId, T.tries);
    if (tooMany) return tooMany;
    const source = await publishSource(deps, accountId, host);
    if (isPublished(source)) return notNewer(source, host, deps);
    const limited = await countIn(deps, PUBLISH_WINDOW, PUBLISH_PER_HOUR, accountId, T.limit);
    if (limited) return limited;

    const result = await publishHost(deps, accountId, host, source.analysis);
    switch (result.outcome) {
      case "published":
      case "refreshed":
        return json(200, { site: publishedView(result.site, deps.config), message: T[result.outcome] });
      // The claim or the publication changed after the checks above: the write checks them again.
      case "no_claim":
        return noClaim(host);
      case "not_verified":
        return notVerified(host);
      case "not_newer":
        return notNewer({ ...source, current: result.site }, host, deps);
      default:
        return json(FAILED_STATUS[result.outcome], {
          error: result.outcome,
          message: T.refreshError[result.outcome](host),
          ...(result.site ? { site: publishedView(result.site, deps.config) } : {}),
        });
    }
  });
}

/** 409 not_newer. `retryAt`: until then Retrofit reuses the analysis's read, so a new analysis brings nothing newer. */
function notNewer({ analysis, current }: PublishSource, host: string, deps: PublishDeps): Response {
  const from = analysis && newReadFrom(analysis, deps);
  return json(409, {
    error: "not_newer",
    message: from ? T.sameRead(host, Math.round(deps.config.crawlCacheTtlS / 360) / 10, from) : T.notNewer(host),
    ...(from ? { retryAt: from.toISOString() } : {}),
    site: current && publishedView(current, deps.config),
  });
}

/** POST /api/publish/remove `{host}` -> 200 `{site: null, message}`: unpublishes the account's own site, also a paused one. 404 not_found when the account publishes no such host. */
export function handleUnpublish(request: Request, deps: PublishDeps): Promise<Response> {
  return accountPost("/api/publish/remove", T, request, deps, async ({ accountId }, fields) => {
    const host = hostOf(fields);
    if (!host) return invalid();
    const removed = await deps.accounts.unpublishSite(accountId, host);
    return removed ? json(200, { site: null, message: T.unpublished }) : json(404, { error: "not_found", message: T.notPublished(host), site: null });
  });
}
