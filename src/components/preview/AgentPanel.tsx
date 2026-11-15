"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
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
  const guard = typeof window === "undefined" ? null : pageGuard();

  return (
    <section className="mt-10" aria-labelledby={`${title}-heading`}>
      <h2 id={`${title}-heading`} className="text-xl font-semibold">
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
