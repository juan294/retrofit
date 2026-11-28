"use client";

import { SitePage } from "@/components/SitePage";
import { PUBLISHED_PAGE_TEXT as T } from "@/lib/site/publish-texts";

/** /s/<host> while the account data is unavailable: the fixed text and a retry, nothing of the error itself. */
export default function PublishedError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <SitePage title={T.unavailableTitle}>
      <p className="mt-4" role="alert">
        {T.unavailable}
      </p>
      <button type="button" onClick={() => retry()} className="mt-6 rounded px-4 py-2 font-medium" style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}>
        {T.tryAgain}
      </button>
    </SitePage>
  );
}
