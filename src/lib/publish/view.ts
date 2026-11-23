import type { PublishedSite } from "@/lib/accounts/data";
import { badgeSnippet } from "@/lib/badge/snippet";
import type { Config } from "@/lib/config";
import { dateText } from "@/lib/site/account-texts";
import { PUBLISH_TEXT } from "@/lib/site/publish-texts";
import { publishedUrl } from "./url";

/** A published site as its owner's account page and the publish API show it. */
export interface PublishedView {
  readonly host: string;
  /** The public page. It answers only while the claim is verified. */
  readonly url: string;
  /** When Retrofit read the published copy, as the page shows it. */
  readonly savedOn: string;
  /** Why the last refresh failed, or null. */
  readonly error: string | null;
  /** The badge's embed HTML. */
  readonly snippet: string;
}

export function publishedView(site: PublishedSite, config: Pick<Config, "publicOrigin">): PublishedView {
  return {
    host: site.host,
    url: publishedUrl(config.publicOrigin, site.host),
    savedOn: dateText(site.fetchedAt),
    error: site.lastRefreshError === null ? null : PUBLISH_TEXT.refreshError[site.lastRefreshError](site.host),
    snippet: badgeSnippet(config.publicOrigin, site.host),
  };
}
