"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { noticeForTrace, type Notice } from "@/lib/preview/notices";
import type { ConsentInfo } from "@/lib/preview/fetch-guard";
import { closePreviewAccess, installPageGuard } from "@/lib/preview/page-guard";

/** Router, key and model the runtime uses. The key never leaves the browser except to `router`. */
export interface Inference {
  readonly router: string;
  readonly key: string;
  readonly model: string;
}

interface RuntimeHandle {
  engine: { requestConsent: (this: unknown, info: ConsentInfo) => unknown };
  trace: EventTarget;
}
interface RuntimeModule {
  boot(root: HTMLElement, opts: Record<string, unknown>): Promise<RuntimeHandle>;
}

export interface PreviewProps {
  /** Absolute base of the network: `<origin>/p/<id>` for a preview, `location.origin` for Retrofit's own agent. */
  readonly originUrl: string;
  readonly inference: Inference;
  /** Shown above the chat; cannot be hidden by the runtime. */
  readonly label?: ReactNode;
}

const RUNTIME_URL = "/runtime/index.js";

/** An error whose message is already a visitor text. */
class VisitorError extends Error {}

/**
 * The only component that calls the vendored runtime's API. It installs the
 * fetch guard before `boot` (the runtime fetches the manifest, network and
 * action module during boot), configures the guard from the manifest, wraps
 * the engine's consent hook so approvals reach the guard, and shows trace
 * outcomes that the runtime reports only as tool results.
 */
export function Preview({ originUrl, inference, label }: PreviewProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let cancelled = false;
    const guard = installPageGuard();
    setNotices([]);
    setBootError(null);

    (async () => {
      try {
        guard.clearApprovals();
        guard.setRouter(inference.router);
        guard.revokeProvider();
        const res = await fetch(`${originUrl}/agent-manifest.json`, { cache: "no-store", credentials: "same-origin" });
        if (!res.ok) {
          // The preview route answers with a visitor text (generation failed, expired, other browser).
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new VisitorError(body?.message ?? `The agent manifest answered HTTP ${res.status}.`);
        }
        const manifest = (await res.json()) as { allowed_peers?: unknown };
        // A cancelled boot must not write its peers into the guard the next preview uses.
        if (cancelled) return;
        guard.setPolicyPeers(Array.isArray(manifest.allowed_peers) ? manifest.allowed_peers.filter((x): x is string => typeof x === "string") : []);

        mount.replaceChildren();
        const chat = document.createElement("div");
        chat.dataset.nsSlot = "chat";
        const agents = document.createElement("div");
        agents.dataset.nsSlot = "agents";
        // The runtime never stores a key profile here: its settings slot stays mounted but hidden.
        const settings = document.createElement("details");
        settings.dataset.nsSlot = "settings";
        settings.hidden = true;
        mount.append(chat, agents, settings);

        const runtime = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ RUNTIME_URL)) as RuntimeModule;
        if (cancelled) return;
        const handle = await runtime.boot(mount, {
          originUrl,
          sandboxWorkerUrl: "/runtime/sandbox-worker.js",
          byokKey: inference.key,
          router: inference.router,
          model: inference.model,
        });
        if (cancelled) {
          // A boot that finished after unmount re-exposed its engine (and key) on window.__nsweb.
          delete (window as { __nsweb?: unknown }).__nsweb;
          return;
        }
        handle.engine.requestConsent = guard.wrapRequestConsent(handle.engine.requestConsent);
        handle.trace.addEventListener("event", (e) => {
          const notice = noticeForTrace((e as CustomEvent<Record<string, unknown>>).detail);
          if (notice) setNotices((list) => (list.some((n) => n.text === notice.text) ? list : [...list, notice]));
        });
      } catch (e) {
        if (!cancelled) setBootError(e instanceof VisitorError ? e.message : `Retrofit could not start this agent: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();

    return () => {
      cancelled = true;
      mount.replaceChildren();
      closePreviewAccess(guard);
    };
  }, [originUrl, inference.router, inference.key, inference.model]);

  return (
    <section className="mt-6" aria-label="Agent">
      {label ? (
        <p data-testid="preview-label" className="rounded border px-3 py-2 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}>
          {label}
        </p>
      ) : null}
      {bootError ? (
        <p role="alert" className="mt-3" style={{ color: "var(--color-danger)" }}>
          {bootError}
        </p>
      ) : null}
      <div ref={mountRef} className="mt-3" data-testid="preview-mount" />
      {notices.length ? (
        <ul data-testid="preview-notices" aria-live="polite" className="mt-3 flex flex-col gap-1 text-sm">
          {notices.map((n) => (
            <li key={n.text} data-kind={n.kind} style={{ color: n.kind === "loop" || n.kind === "limit" ? "var(--color-muted)" : "var(--color-danger)" }}>
              {n.text}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
