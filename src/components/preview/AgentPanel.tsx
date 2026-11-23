"use client";

import { useCallback, useId, useState, type ReactNode } from "react";
import { KeyPanel } from "@/components/key-panel/KeyPanel";
import { pageGuard } from "@/lib/preview/page-guard";
import type { Notice } from "@/lib/preview/notices";
import { Preview } from "./Preview";
import { useFreeSession } from "./useFreeSession";
import { useOwnKey } from "./useOwnKey";

export interface AgentPanelProps {
  /** Path of the network base on this origin: `""` for Retrofit's own agent, `/p/<id>` for a preview. */
  readonly basePath: string;
  readonly label?: ReactNode;
  readonly title: string;
  /** A network of the manifest to run instead of networks[0] (Preview's `network`). */
  readonly network?: string;
}

/**
 * Key panel plus the runtime. Without a visitor key the agent runs on
 * Retrofit's free path; a connected key reboots the runtime with that
 * provider, and "Forget my key" returns to the free path.
 */
export function AgentPanel({ basePath, label, title, network }: AgentPanelProps) {
  const { ownKey, originUrl, hasStoredKey, onConnect, onForget } = useOwnKey(basePath);
  const free = useFreeSession(originUrl !== null && ownKey === null && !hasStoredKey);
  const inference = ownKey ?? (free.status === "ready" ? free.inference : null);
  // A free-path refusal seen in chat (cap, hold, provider error) also shows as a banner with the key offer.
  const [freeNotice, setFreeNotice] = useState<string | null>(null);
  const onNotice = useCallback((n: Notice) => n.kind === "free" && setFreeNotice(n.text), []);
  const banner = ownKey ? null : free.status === "unavailable" ? free.message : freeNotice;
  // The key panel renders only after mount (originUrl is set by the mount effect): the server and
  // the first client render match, and no key form exists before the page's scripts run.
  const guard = originUrl ? pageGuard() : null;
  const headingId = useId();

  return (
    <section className="mt-10" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-xl font-semibold">
        {title}
      </h2>
      {banner ? (
        <p data-testid="free-banner" role="status" className="mt-3 rounded border px-3 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>
          {banner} <a href="#key-panel" className="underline">Use your own key</a>
        </p>
      ) : null}
      {guard ? (
        <div id="key-panel">
          <KeyPanel
            guard={guard}
            onConnect={onConnect}
            onForget={onForget}
            freePathActive={!ownKey && free.status === "ready"}
            freePathStarting={!ownKey && !hasStoredKey && free.status === "starting"}
          />
        </div>
      ) : null}
      {inference && originUrl ? <Preview originUrl={originUrl} inference={inference} label={label} onNotice={onNotice} network={network} /> : null}
      {!inference && label ? (
        <p data-testid="preview-label" className="mt-3 rounded border px-3 py-2 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}>
          {label}
        </p>
      ) : null}
    </section>
  );
}
