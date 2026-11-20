"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { serveTopManifest, withTopNetwork } from "@/lib/peer/conformance";
import { friendlyRuntimeError } from "@/lib/preview/error-text";
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
  /** Called for each new notice (the agent panel shows free-path notices as a banner). */
  readonly onNotice?: (notice: Notice) => void;
  /**
   * A network of the manifest to run instead of networks[0] (the /conformance page). The
   * runtime always runs networks[0], so during boot it gets the manifest with this network first.
   */
  readonly network?: string;
}

const RUNTIME_URL = "/runtime/index.js";

/** An error whose message is already a visitor text. */
class VisitorError extends Error {}

type RuntimeWindow = { __nsweb?: { engine?: unknown } };
/** The `window.__nsweb` value of the preview that is mounted now (boot sets it for every runtime). */
let liveHandle: RuntimeWindow["__nsweb"];

/**
 * The only component that calls the vendored runtime's API. It installs the
 * fetch guard before `boot` (the runtime fetches the manifest, network and
 * action module during boot), configures the guard from the manifest, wraps
 * the engine's consent hook so approvals reach the guard, and shows trace
 * outcomes that the runtime reports only as tool results.
 */
export function Preview({ originUrl, inference, label, onNotice, network }: PreviewProps) {
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;
  const mountRef = useRef<HTMLDivElement>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);

  // The runtime prints a router error as "⚠️ LLM HTTP 429: {json}". Show the JSON error's message instead.
  // Only that bubble's text changes; a non-JSON body (for example HTML) stays as the runtime escaped it.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const rewrite = () => {
      for (const bubble of mount.querySelectorAll<HTMLElement>(".ns-msg.bot")) {
        const friendly = friendlyRuntimeError(bubble.textContent ?? "");
        if (friendly !== null) bubble.textContent = friendly;
      }
    };
    const observer = new MutationObserver(rewrite);
    observer.observe(mount, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let cancelled = false;
    let detachTrace = () => {};
    const guard = installPageGuard();
    setNotices([]);
    setBootError(null);

    (async () => {
      try {
        guard.clearApprovals();
        // This runtime's own base under the router: the guard retires it when the preview unmounts,
        // so a runtime that outlives its preview cannot reach the router (even a same-origin one).
        const runtimeRouter = guard.setRouter(inference.router)!;
        guard.revokeProvider();
        const res = await fetch(`${originUrl}/agent-manifest.json`, { cache: "no-store", credentials: "same-origin" });
        if (!res.ok) {
          // The preview route answers with a visitor text (generation failed, expired, other browser).
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new VisitorError(body?.message ?? `The agent manifest answered HTTP ${res.status}.`);
        }
        const manifest = (await res.json()) as { allowed_peers?: unknown; networks: { name?: unknown }[] };
        const top = network ? withTopNetwork(manifest, network) : manifest;
        if (!top) throw new VisitorError(`This site's agent manifest does not list the network ${network}.`);
        // A cancelled boot must not write its peers into the guard the next preview uses.
        if (cancelled) return;
        guard.setPolicyPeers(Array.isArray(manifest.allowed_peers) ? manifest.allowed_peers.filter((x): x is string => typeof x === "string") : []);

        // Each boot renders into its own root: a boot that finishes after its preview was replaced
        // renders into a detached root and never takes over the next runtime's slots.
        const root = document.createElement("div");
        const chat = document.createElement("div");
        chat.dataset.nsSlot = "chat";
        const agents = document.createElement("div");
        agents.dataset.nsSlot = "agents";
        // The runtime never stores a key profile here: its settings slot stays mounted but hidden.
        const settings = document.createElement("details");
        settings.dataset.nsSlot = "settings";
        settings.hidden = true;
        root.append(chat, agents, settings);
        mount.replaceChildren(root);

        const runtime = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ RUNTIME_URL)) as RuntimeModule;
        if (cancelled) return;
        // boot fetches the manifest once (runtime/engine.js loadTop); the reordered copy answers only that fetch.
        const release = network ? serveTopManifest(window, `${originUrl}/agent-manifest.json`, top) : () => {};
        let handle: RuntimeHandle;
        try {
          handle = await runtime.boot(root, {
            originUrl,
            sandboxWorkerUrl: "/runtime/sandbox-worker.js",
            byokKey: inference.key,
            router: runtimeRouter,
            model: inference.model,
          });
        } finally {
          release();
        }
        const w = window as RuntimeWindow;
        if (cancelled) {
          // A boot that finished after unmount re-exposed its engine (and key) on window.__nsweb,
          // possibly over the live preview's handle: put the live one back, or remove it.
          if (w.__nsweb?.engine === handle.engine) {
            if (liveHandle) w.__nsweb = liveHandle;
            else delete w.__nsweb;
          }
          return;
        }
        liveHandle = w.__nsweb;
        handle.engine.requestConsent = guard.wrapRequestConsent(handle.engine.requestConsent);
        const onTrace = (e: Event) => {
          const notice = noticeForTrace((e as CustomEvent<Record<string, unknown>>).detail);
          if (!notice) return;
          onNoticeRef.current?.(notice);
          setNotices((list) => (list.some((n) => n.text === notice.text) ? list : [...list, notice]));
        };
        handle.trace.addEventListener("event", onTrace);
        // A retired runtime's trace (its refused calls) must not reach the next preview's notices.
        detachTrace = () => handle.trace.removeEventListener("event", onTrace);
      } catch (e) {
        if (!cancelled) setBootError(e instanceof VisitorError ? e.message : `Retrofit could not start this agent: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();

    return () => {
      cancelled = true;
      detachTrace();
      mount.replaceChildren();
      liveHandle = undefined;
      closePreviewAccess(guard);
    };
  }, [originUrl, inference.router, inference.key, inference.model, network]);

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
      <div ref={mountRef} className="runtime-surface mt-3" data-testid="preview-mount" />
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
