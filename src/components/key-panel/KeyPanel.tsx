"use client";

// Neutral-style key panel (docs/decisions/2026-11-15-open-source-and-key-panel-style.md).
// The key goes only to the provider (lib/keys/test-key.ts) and to this browser's storage. It is
// never sent to Retrofit's origin, never put in a URL and never rendered back after submit: the
// field is uncontrolled and cleared on every submit, and React state never holds the key.

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { connectKey, priceText, type Connection, type KeyGuard } from "@/lib/keys/connect";
import { detectProvider } from "@/lib/keys/detect";
import { BUTTON_PROVIDERS, providerForRouter, type Provider } from "@/lib/keys/providers";
import { forgetAll, loadKey, saveKey } from "@/lib/keys/storage";

export type KeyPanelProps = {
  guard: KeyGuard;
  /** Called with a validated key; the caller reboots the preview, then setRouter and revokeProvider. */
  onConnect: (connection: Connection) => void;
  /** Called after "Forget my key" cleared storage and revoked the provider. */
  onForget: () => void;
  /** Phase 6: Retrofit's free AI is in use while no key is connected. */
  freePathActive?: boolean;
  /** Retrofit's free AI is starting: the key form stays closed, so it does not flash open first. */
  freePathStarting?: boolean;
  /**
   * A saved key waits for a click on "Use your saved key", on every page load, instead of connecting by itself.
   * For pages whose agent another site's owner published: a key saved elsewhere on Retrofit must not run there unasked.
   */
  askForSavedKey?: boolean;
};

type Connected = { provider: string; price: string; note: string | null };

const field = { borderColor: "var(--color-border)", background: "var(--color-surface)", color: "var(--color-text)" };
const muted = { color: "var(--color-muted)" };

export function KeyPanel({ guard, onConnect, onForget, freePathActive = false, freePathStarting = false, askForSavedKey = false }: KeyPanelProps) {
  const ids = useId();
  const keyRef = useRef<HTMLInputElement>(null);
  const attempt = useRef(0);
  const [detected, setDetected] = useState<Provider | null>(null);
  const [router, setRouter] = useState("");
  const [model, setModel] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<Connected | null>(null);

  const advancedProvider = router ? providerForRouter(router) : null;
  const keyPage = advancedProvider ?? detected;

  // The provider of a saved key that waits for the visitor's click (askForSavedKey). Never the key itself.
  const [offered, setOffered] = useState<string | null>(null);

  // Restore a key saved earlier in this tab (or remembered on this device) once on mount, or only offer it.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const saved = loadKey();
    const provider = saved ? providerForRouter(saved.router) : null;
    if (!saved || !provider) return;
    setRemember(saved.remembered);
    if (askForSavedKey) return setOffered(provider.name);
    setConnected({ provider: provider.name, price: priceText(undefined), note: null });
    onConnect({ provider: provider.name, router: provider.router, model: saved.model, key: saved.key });
  }, [onConnect, askForSavedKey]);

  /** The visitor chose the saved key: read it from storage now and connect. */
  function takeSavedKey() {
    const saved = loadKey();
    const provider = saved ? providerForRouter(saved.router) : null;
    setOffered(null);
    if (!saved || !provider) return;
    attempt.current += 1;
    setBusy(false);
    setError(null);
    setConnected({ provider: provider.name, price: priceText(undefined), note: null });
    onConnect({ provider: provider.name, router: provider.router, model: saved.model, key: saved.key });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const input = keyRef.current;
    const key = input?.value ?? "";
    if (input) input.value = "";
    setDetected(null);
    setError(null);
    setBusy(true);
    const mine = ++attempt.current;
    const result = await connectKey({ guard, key, router: router || undefined, model: model || undefined });
    if (mine !== attempt.current) return;
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    saveKey(result.connection, { remember });
    setOffered(null);
    setConnected({ provider: result.connection.provider, price: result.price, note: result.note });
    onConnect(result.connection);
  }

  function forget() {
    attempt.current += 1;
    forgetAll();
    guard.revokeProvider();
    if (keyRef.current) keyRef.current.value = "";
    setBusy(false);
    setDetected(null);
    setError(null);
    setConnected(null);
    setRemember(false);
    onForget();
  }

  const body = (
    <>
      <h2 id={`${ids}-heading`} className="font-medium">
        {freePathActive ? "Use your own key" : "Connect your AI key"}
      </h2>

      {connected ? (
        <div role="status" className="flex flex-col gap-1">
          <p className="font-medium" style={{ color: "var(--color-ok)" }}>
            Connected to {connected.provider}
          </p>
          {connected.note ? <p className="text-sm">{connected.note}</p> : null}
          <p className="text-sm" style={muted}>
            {connected.price}
          </p>
        </div>
      ) : null}

      {offered ? (
        <div className="flex flex-col items-start gap-1" data-testid="saved-key">
          <button type="button" onClick={takeSavedKey} className="rounded px-4 py-2 font-medium" style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}>
            Use your saved key
          </button>
          <p className="text-sm" style={muted}>
            A key for {offered} is saved in this browser. This page does not use it unless you choose to.
          </p>
        </div>
      ) : null}

      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <label htmlFor={`${ids}-key`} className="text-sm font-medium">
          {connected ? "Paste a different key" : "Paste your key"}
        </label>
        <div className="flex gap-2">
          <input
            id={`${ids}-key`}
            ref={keyRef}
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="sk-or-v1-…"
            className="min-w-0 flex-1 rounded border px-3 py-2"
            style={field}
            aria-describedby={`${ids}-hint${error ? ` ${ids}-error` : ""}`}
            onChange={(e) => setDetected(detectProvider(e.currentTarget.value))}
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded px-4 py-2 font-medium"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            {busy ? "Checking…" : "Connect"}
          </button>
        </div>
        <p id={`${ids}-hint`} className="text-sm" style={muted}>
          {detected ? <>Detected: {detected.name}. </> : null}
          The key goes straight from this browser to your provider. Use a key with a spending limit.
        </p>
        {keyPage ? (
          <p className="text-sm">
            <a href={keyPage.keyUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-accent)" }}>
              Get or check a {keyPage.name} key
            </a>{" "}
            <span style={muted}>({keyPage.accessNote})</span>
          </p>
        ) : null}
        {error ? (
          <p id={`${ids}-error`} role="alert" className="text-sm" style={{ color: "var(--color-danger)" }}>
            {error}
          </p>
        ) : null}

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
          Remember on this device
        </label>

        <details className="text-sm">
          <summary className="cursor-pointer" style={muted}>
            Advanced
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <label htmlFor={`${ids}-router`}>Provider and router</label>
            <select
              id={`${ids}-router`}
              value={router}
              onChange={(e) => setRouter(e.currentTarget.value)}
              className="rounded border px-2 py-1"
              style={field}
            >
              <option value="">Match my key</option>
              {BUTTON_PROVIDERS.map((p) => (
                <option key={p.router} value={p.router}>
                  {p.name} ({p.router})
                </option>
              ))}
            </select>
            <label htmlFor={`${ids}-model`}>Model</label>
            <input
              id={`${ids}-model`}
              type="text"
              value={model}
              onChange={(e) => setModel(e.currentTarget.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={advancedProvider?.model ?? "Provider default"}
              className="rounded border px-2 py-1"
              style={field}
            />
          </div>
        </details>
      </form>

      {connected ? (
      <button
        type="button"
        onClick={forget}
        className="self-start rounded border px-3 py-1 text-sm"
        style={{ borderColor: "var(--color-border)", color: "var(--color-text)" }}
      >
        Forget my key
      </button>
      ) : null}
    </>
  );

  // The free AI is working or about to: the key form is optional and starts closed.
  const freeFirst = (freePathActive || freePathStarting) && !connected;

  return (
    <section
      aria-labelledby={`${ids}-heading`}
      className="flex flex-col gap-3 border p-4"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)", borderRadius: "var(--radius)" }}
    >
      {freeFirst ? (
        <p className="text-sm" style={{ color: freePathActive ? "var(--color-ok)" : "var(--color-muted)" }} role="status">
          {freePathActive ? <>Using Retrofit&apos;s free AI</> : <>Starting Retrofit&apos;s free AI…</>}
        </p>
      ) : null}
      {/* One structure in every state, so the form is never rebuilt (a key being typed survives the free
          session becoming ready). Closed while the free AI starts or works and no key is connected. */}
      <details data-testid="own-key" open={!freeFirst} className="flex flex-col gap-3">
        <summary className="cursor-pointer text-sm font-medium">{freeFirst ? "Use your own AI key (optional)" : "Your AI key"}</summary>
        <div className="mt-3 flex flex-col gap-3">{body}</div>
      </details>
    </section>
  );
}
