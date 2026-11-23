"use client";

import { useId } from "react";
import { KeyPanel } from "@/components/key-panel/KeyPanel";
import { Preview } from "@/components/preview/Preview";
import { useOwnKey } from "@/components/preview/useOwnKey";
import { pageGuard } from "@/lib/preview/page-guard";
import { PUBLISHED_PAGE_TEXT as T } from "@/lib/site/publish-texts";

/**
 * The agent on /s/<host>: the key panel and the runtime on the visitor's own key. It is not AgentPanel,
 * because a published page never uses Retrofit's free AI: nothing here imports the free session.
 */
export function PublishedAgent({ host }: { host: string }) {
  const { ownKey, originUrl, onConnect, onForget } = useOwnKey(`/s/${host}`);
  // As in AgentPanel: the key form exists only after mount, so no key is typed before the page's scripts run.
  const guard = originUrl ? pageGuard() : null;
  const headingId = useId();
  return (
    <section className="mt-10" aria-labelledby={headingId} data-testid="published-agent">
      <h2 id={headingId} className="text-xl font-semibold">
        {T.agentTitle(host)}
      </h2>
      <p className="mt-2 text-sm" style={{ color: "var(--color-muted)" }}>
        {T.ownKey}
      </p>
      {guard ? (
        <div id="key-panel" className="mt-3">
          <KeyPanel guard={guard} onConnect={onConnect} onForget={onForget} />
        </div>
      ) : null}
      {ownKey && originUrl ? <Preview originUrl={originUrl} inference={ownKey} /> : null}
    </section>
  );
}
