"use client";

import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { KeyPanel } from "@/components/key-panel/KeyPanel";
import type { Connection } from "@/lib/keys/connect";
import { pageGuard } from "@/lib/preview/page-guard";
import { Preview, type Inference } from "./Preview";

export interface AgentPanelProps {
  /** Path of the network base on this origin: `""` for Retrofit's own agent, `/p/<id>` for a preview. */
  readonly basePath: string;
  readonly label?: ReactNode;
  readonly title: string;
}

/**
 * Key panel plus the runtime. Before Phase 6 there is no free path, so the
 * agent starts once the visitor connects a key. A new key reboots the runtime.
 */
export function AgentPanel({ basePath, label, title }: AgentPanelProps) {
  const [inference, setInference] = useState<Inference | null>(null);
  // The runtime needs an absolute base (research §4); the origin is known only in the browser.
  const [originUrl, setOriginUrl] = useState<string | null>(null);
  useEffect(() => setOriginUrl(`${window.location.origin}${basePath}`), [basePath]);

  const onConnect = useCallback((c: Connection) => setInference({ router: c.router, key: c.key, model: c.model }), []);
  const onForget = useCallback(() => setInference(null), []);
  // The key panel renders only after mount (originUrl is set by the mount effect): the server and
  // the first client render match, and no key form exists before the page's scripts run.
  const guard = originUrl ? pageGuard() : null;
  const headingId = useId();

  return (
    <section className="mt-10" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-xl font-semibold">
        {title}
      </h2>
      {guard ? <KeyPanel guard={guard} onConnect={onConnect} onForget={onForget} /> : null}
      {inference && originUrl ? <Preview originUrl={originUrl} inference={inference} label={label} /> : null}
      {!inference && label ? (
        <p data-testid="preview-label" className="mt-3 rounded border px-3 py-2 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}>
          {label}
        </p>
      ) : null}
    </section>
  );
}
