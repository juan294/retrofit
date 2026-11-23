import type { ReactNode } from "react";
import type { PublishedView } from "@/lib/publish/view";
import { PUBLISH_TEXT as T } from "@/lib/site/publish-texts";

const border = { borderColor: "var(--color-border)" };
const muted = { color: "var(--color-muted)" };
const danger = { color: "var(--color-danger)" };

/**
 * The publish part of one claim panel: Publish for a verified claim, then the public link, the saved
 * date, the last refresh error, Refresh, Unpublish and the badge snippet. While the claim is not
 * verified a publication is paused: its link would answer 404, so only Unpublish stays. `button` makes
 * one POST form (ClaimsSection), which sends the claim's host.
 */
export function PublishControls({ verified, site, button }: { verified: boolean; site: PublishedView | null; button: (label: string, path: string, primary?: boolean) => ReactNode }) {
  if (!site && !verified) return null;
  const unpublish = button(T.unpublish, "/api/publish/remove");
  return (
    <div className="mt-4 border-t pt-3" style={border} data-testid="publish">
      {!site ? (
        <>
          <p>{T.intro}</p>
          <div className="mt-2">{button(T.publish, "/api/publish", true)}</div>
        </>
      ) : !verified ? (
        <>
          <p data-testid="publish-paused" style={danger}>
            {T.paused}
          </p>
          <div className="mt-2">{unpublish}</div>
        </>
      ) : (
        <>
          <p className="break-words">
            {T.publicPage}{" "}
            <a href={site.url} className="underline" data-testid="publish-link">
              {site.url}
            </a>
          </p>
          <p className="mt-1 text-sm" style={muted} data-testid="publish-saved">
            {T.savedOn(site.savedOn)}
          </p>
          {site.error ? (
            <p className="mt-2 break-words" style={danger} data-testid="publish-error">
              {T.lastRefreshFailed} {site.error}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {button(site.error ? T.tryAgain : T.refresh, "/api/publish", true)}
            {unpublish}
          </div>
          <p className="mt-3">{T.badgeHeading}</p>
          <code className="mt-1 block rounded border p-2 text-sm break-all" style={{ ...border, background: "var(--color-surface)" }} data-testid="badge-snippet">
            {site.snippet}
          </code>
        </>
      )}
    </div>
  );
}
