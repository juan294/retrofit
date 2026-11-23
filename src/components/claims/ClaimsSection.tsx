"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { ClaimOption } from "@/lib/claims/sources";
import type { AccountClaimView, ClaimView } from "@/lib/claims/view";
import type { PublishedView } from "@/lib/publish/view";
import { PublishControls } from "../publish/PublishControls";
import { PLAN_TEXT } from "@/lib/site/billing-texts";
import { CLAIMS_TEXT as T } from "@/lib/site/claims-texts";
import { localizeRetry } from "../analysis/retry-time";
import { useHydrated } from "../useHydrated";

type Status = { readonly ok: boolean; readonly text: string; readonly href?: string } | null;
type Answer = { message?: unknown; retryAt?: unknown; href?: unknown; token?: unknown; claim?: Partial<ClaimView>; site?: PublishedView | null };

/** The claim view of an answer, when it carries a whole one. */
const viewOf = (answer: Answer | null): ClaimView | null => (typeof answer?.claim?.id === "string" && typeof answer.claim.statusText === "string" ? (answer.claim as ClaimView) : null);

const accent = { background: "var(--color-accent)", color: "var(--color-accent-text)" };
const border = { borderColor: "var(--color-border)" };
const muted = { color: "var(--color-muted)" };
const danger = { color: "var(--color-danger)" };

/**
 * "Your sites" on /account: claim a site from a recent analysis or a saved report, and one panel per
 * claim with what to add, Check again, Start over, the other method, Remove, and the publish controls.
 * Every action is a POST form sent as JSON to /api/claims/* or /api/publish; buttons stay disabled until
 * hydration. A new token (after a claim or Start over) lives only in this component's state, so it is
 * shown once: a reload shows only where the record goes. Check again and Start over show the claim their
 * answer carries, and Publish and Unpublish the site theirs carries; a new or removed claim reads the
 * server data again (router.refresh).
 */
export function ClaimsSection({ claims, options }: { claims: readonly AccountClaimView[]; options: readonly ClaimOption[] }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [busy, setBusy] = useState<string | null>(null);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  // The server's claims, with the claims and sites later answers carried; new server data (after a refresh) replaces them.
  const [views, setViews] = useState(claims);
  const [fromServer, setFromServer] = useState(claims);
  if (claims !== fromServer) {
    setFromServer(claims);
    setViews(claims);
  }

  /** Puts what an answer carried into the claim's panel. */
  const merge = (claimId: string, change: Partial<AccountClaimView>) => setViews((vs) => vs.map((v) => (v.id === claimId ? { ...v, ...change } : v)));

  /** Posts `body` to `path`; shows the answer's message under `key` (a claim id, or "new"); keeps a returned token. */
  async function send(path: string, body: Record<string, string>, key: string): Promise<void> {
    setBusy(key);
    setStatuses((s) => ({ ...s, [key]: null }));
    let status: Status;
    try {
      const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await res.json().catch(() => null)) as Answer | null;
      const message = typeof answer?.message === "string" ? answer.message : T.unavailable;
      status = { ok: res.ok, text: res.ok ? message : localizeRetry(message, typeof answer?.retryAt === "string" ? answer.retryAt : undefined), ...(answer?.href === "/pricing" ? { href: answer.href } : {}) };
      const view = viewOf(answer);
      // A publish answer (`key` is the claim's id).
      if (answer?.site !== undefined) merge(key, { site: answer.site });
      if (res.ok && view && typeof answer?.token === "string") {
        const token = answer.token;
        setTokens((t) => ({ ...t, [view.id]: token }));
      }
      if (key === "new" || path === "/api/claims/remove") {
        // A new claim shows its answer in its own panel.
        if (res.ok && view && key === "new") key = view.id;
        if (res.ok) router.refresh();
      } else if (view) {
        merge(view.id, view);
      }
    } catch {
      status = { ok: false, text: T.unavailable };
    }
    setStatuses((s) => ({ ...s, [key]: status }));
    setBusy(null);
  }

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void send("/api/claims", { source: String(form.get("source") ?? ""), method: String(form.get("method") ?? "meta") }, "new");
  }

  const disabled = !hydrated || busy !== null;

  return (
    <section data-testid="claims">
      <h2 className="mt-10 text-xl font-semibold">{T.heading}</h2>
      <p className="mt-2">{T.intro}</p>
      {options.length === 0 ? (
        <p className="mt-2">{views.length === 0 ? T.noSources : T.noMoreSources}</p>
      ) : (
        <form method="post" action="/api/claims" onSubmit={onCreate} className="mt-4 flex flex-col items-start gap-3">
          <label className="flex w-full flex-col gap-1">
            <span className="font-medium">{T.sourceLabel}</span>
            <select name="source" className="w-full max-w-full rounded border px-3 py-2" style={{ ...border, background: "var(--color-surface)" }}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend className="font-medium">{T.methodLegend}</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="method" value="meta" defaultChecked /> {T.methodMeta}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="method" value="dns" /> {T.methodDns}
            </label>
          </fieldset>
          <button type="submit" disabled={disabled} className="rounded px-4 py-2 font-medium" style={accent}>
            {busy === "new" ? T.busy : T.claimButton}
          </button>
        </form>
      )}
      <Message status={statuses.new ?? null} testId="claims-message" />

      {views.length === 0 ? (
        <p className="mt-4">{T.noClaims}</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {views.map((c) => (
            <ClaimPanel key={c.id} claim={c} token={tokens[c.id] ?? null} status={statuses[c.id] ?? null} busy={busy === c.id} disabled={disabled} send={(path, body) => send(path, { claimId: c.id, ...body }, c.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Message({ status, testId }: { status: Status; testId: string }) {
  if (!status) return null;
  return (
    <p className="mt-2" role={status.ok ? "status" : "alert"} data-testid={testId} style={status.ok ? undefined : danger}>
      {status.text}{" "}
      {status.href ? (
        <a href={status.href} className="underline">
          {PLAN_TEXT.seePlans}
        </a>
      ) : null}
    </p>
  );
}

function ClaimPanel(p: { claim: AccountClaimView; token: string | null; status: Status; busy: boolean; disabled: boolean; send: (path: string, body?: Record<string, string>) => Promise<void> }) {
  const { claim: c, token } = p;
  const action = (path: string, body: Record<string, string> = {}) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void p.send(path, body);
  };
  const button = (label: string, path: string, body?: Record<string, string>, primary = false) => (
    <form method="post" action={path} onSubmit={action(path, body)}>
      <button type="submit" disabled={p.disabled} className={primary ? "rounded px-4 py-2 font-medium" : "rounded border px-4 py-2"} style={primary ? accent : border}>
        {label}
      </button>
    </form>
  );
  const warn = c.status === "lapsed" || c.status === "superseded";

  return (
    <li className="rounded border p-3" style={border} data-testid="claim" data-host={c.host}>
      <p className="font-medium break-words">{c.host}</p>
      <p data-testid="claim-status" style={warn ? danger : undefined}>
        {c.statusText}
      </p>
      {token ? (
        <div className="mt-2" data-testid="claim-token">
          <p>{c.method === "meta" ? T.addTag(c.url) : T.addRecord(c.recordName)}</p>
          <code className="mt-1 block rounded border p-2 text-sm break-all" style={{ ...border, background: "var(--color-surface)" }}>
            {c.method === "meta" ? T.metaTag(token) : T.txtValue(token)}
          </code>
          <p className="mt-1 text-sm" style={muted}>
            {T.tokenOnce}
          </p>
        </div>
      ) : c.canStartOver ? (
        <p className="mt-2 break-words">{c.where}</p>
      ) : null}
      {c.reason ? (
        <p className="mt-2 break-words" data-testid="claim-reason">
          {c.reason}
        </p>
      ) : null}
      <p className="mt-1 text-sm" style={muted}>
        {c.lastChecked}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {c.canCheck ? button(p.busy ? T.busy : T.checkAgain, "/api/claims/check", {}, true) : null}
        {c.canStartOver ? button(T.startOver, "/api/claims/start-over") : null}
        {c.canStartOver ? button(c.method === "meta" ? T.useDns : T.useMeta, "/api/claims/start-over", { method: c.method === "meta" ? "dns" : "meta" }) : null}
        {button(T.remove, "/api/claims/remove")}
      </div>
      <PublishControls verified={c.status === "verified"} site={c.site} button={(label, path, primary) => button(label, path, { host: c.host }, primary)} />
      <Message status={p.status} testId="claim-message" />
    </li>
  );
}
