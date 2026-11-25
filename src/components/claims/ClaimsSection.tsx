"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { ClaimOption } from "@/lib/claims/sources";
import type { AccountClaimView, ClaimView } from "@/lib/claims/view";
import type { PublishedView } from "@/lib/publish/view";
import { PublishControls } from "../publish/PublishControls";
import { ACCOUNT_TEXT } from "@/lib/site/account-texts";
import { CLAIMS_TEXT as T } from "@/lib/site/claims-texts";
import { ConfirmButton } from "../ConfirmButton";
import { postJson, statusOf, type Status } from "../post";
import { StatusMessage } from "../StatusMessage";
import { useFocusFallback } from "../useFocusFallback";
import { useHydrated } from "../useHydrated";
import { buttonState, useOneAtATime } from "../useOneAtATime";

type Answer = { token?: unknown; claim?: Partial<ClaimView>; site?: PublishedView | null };

/** The claim view of an answer, when it carries a whole one. */
const viewOf = (answer: Answer | null): ClaimView | null => (typeof answer?.claim?.id === "string" && typeof answer.claim.statusText === "string" ? (answer.claim as ClaimView) : null);

const accent = { background: "var(--color-accent)", color: "var(--color-accent-text)" };
const border = { borderColor: "var(--color-border)" };
const muted = { color: "var(--color-muted)" };
const danger = { color: "var(--color-danger)" };

/**
 * "Your sites" on /account: claim a site from a recent analysis or a saved report, and one panel per
 * claim with what to add, Check again, Start over, the other method, Remove, and the publish controls.
 * Every action is a POST sent as JSON to /api/claims/* or /api/publish, one at a time; buttons stay disabled
 * until hydration. Remove of a verified or published claim asks first (ConfirmButton). A new token (after a
 * claim or Start over) lives only in this component's state, so it is shown once: a reload shows only where
 * the record goes. Check again and Start over show the claim their answer carries, and Publish and Unpublish
 * the site theirs carries; a removed claim's panel goes at once, and its message is in the section's own
 * status; a new or removed claim reads the server data again (router.refresh).
 */
export function ClaimsSection({ claims, options }: { claims: readonly AccountClaimView[]; options: readonly ClaimOption[] }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { busy, run } = useOneAtATime();
  const { heading, section } = useFocusFallback();
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, Status | null>>({});
  // The server's claims, with the claims and sites later answers carried; new server data (after a refresh) replaces them.
  const [views, setViews] = useState(claims);
  const [fromServer, setFromServer] = useState(claims);
  if (claims !== fromServer) {
    setFromServer(claims);
    setViews(claims);
  }

  /** Puts what an answer carried into the claim's panel. */
  const merge = (claimId: string, change: Partial<AccountClaimView>) => setViews((vs) => vs.map((v) => (v.id === claimId ? { ...v, ...change } : v)));

  /** Posts `body` to `path`; shows the answer's message under `key` (a claim id, or "new": the section); keeps a returned token. */
  const send = (path: string, body: Record<string, string>, key: string) =>
    run(key, async () => {
      setStatuses((s) => ({ ...s, new: null, [key]: null }));
      const res = await postJson<Answer>(path, body);
      const status = statusOf(res, T.unavailable, "/account");
      const answer = res.body;
      const view = viewOf(answer);
      const shown: Record<string, Status> = { [key]: status };
      // A publish answer (`key` is the claim's id).
      if (answer?.site !== undefined) merge(key, { site: answer.site });
      if (res.ok && view && typeof answer?.token === "string") {
        const token = answer.token;
        setTokens((t) => ({ ...t, [view.id]: token }));
        // The panel says what to do with the token; that it is there is the section's message (a new claim) or the panel's own.
        shown[view.id] = { ok: true, text: key === "new" ? T.addShown[view.method] : `${status.text} ${T.addShown[view.method]}` };
      }
      if (res.ok && path === "/api/claims/remove") {
        const host = views.find((v) => v.id === key)?.host;
        setViews((vs) => vs.filter((v) => v.id !== key));
        shown.new = { ...status, text: host ? `${host}: ${status.text}` : status.text };
      } else if (view && key !== "new") {
        merge(view.id, view);
      }
      if (res.ok && (key === "new" || path === "/api/claims/remove")) router.refresh();
      setStatuses((s) => ({ ...s, ...shown }));
    });

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void send("/api/claims", { source: String(form.get("source") ?? ""), method: String(form.get("method") ?? "meta") }, "new");
  }

  return (
    <section data-testid="claims" {...section}>
      <h2 ref={heading} tabIndex={-1} className="mt-10 text-xl font-semibold">
        {T.heading}
      </h2>
      <p className="mt-2">{T.intro}</p>
      {options.length === 0 ? (
        <p className="mt-2">
          {views.length === 0 ? T.noSources : T.noMoreSources}{" "}
          <a href="/" className="underline">
            {ACCOUNT_TEXT.analyze}
          </a>
        </p>
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
          <button type="submit" {...buttonState(hydrated, busy !== null)} className="rounded px-4 py-2 font-medium" style={accent}>
            {busy === "new" ? T.busy : T.claimButton}
          </button>
        </form>
      )}
      <StatusMessage status={statuses.new ?? null} testId="claims-message" className="mt-2" />

      {views.length === 0 ? (
        <p className="mt-4">{T.noClaims}</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {views.map((c) => (
            <ClaimPanel key={c.id} claim={c} token={tokens[c.id] ?? null} status={statuses[c.id] ?? null} working={busy === c.id} hydrated={hydrated} busy={busy !== null} send={(path, body) => send(path, { claimId: c.id, ...body }, c.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ClaimPanel(p: { claim: AccountClaimView; token: string | null; status: Status | null; working: boolean; hydrated: boolean; busy: boolean; send: (path: string, body?: Record<string, string>) => Promise<void> }) {
  const { claim: c, token } = p;
  const action = (path: string, body: Record<string, string> = {}) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void p.send(path, body);
  };
  const name = (label: string) => T.buttonName(label, c.host);
  const button = (label: string, path: string, body?: Record<string, string>, primary = false) => (
    <form method="post" action={path} onSubmit={action(path, body)}>
      <button type="submit" aria-label={name(label)} {...buttonState(p.hydrated, p.busy)} className={primary ? "rounded px-4 py-2 font-medium" : "rounded border px-4 py-2"} style={primary ? accent : border}>
        {label}
      </button>
    </form>
  );
  const warn = c.status === "lapsed" || c.status === "superseded";

  return (
    <li className="rounded border p-3" style={border} data-testid="claim" data-host={c.host}>
      <p tabIndex={-1} className="font-medium break-words">
        {c.host}
      </p>
      <p data-testid="claim-status" style={warn ? danger : undefined}>
        {c.statusText}
        {c.status === "lapsed" && c.site ? ` ${T.lapsedPaused}` : null}
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
        {c.canCheck ? button(p.working ? T.busy : T.checkAgain, "/api/claims/check", {}, true) : null}
        {c.canStartOver ? button(T.startOver, "/api/claims/start-over") : null}
        {c.canStartOver ? button(c.method === "meta" ? T.useDns : T.useMeta, "/api/claims/start-over", { method: c.method === "meta" ? "dns" : "meta" }) : null}
        {c.status === "verified" || c.site ? (
          <ConfirmButton label={T.remove} question={T.removeQuestion(c.host, c.site !== null)} confirm={T.removeConfirm} cancel={T.removeCancel} name={name} hydrated={p.hydrated} busy={p.busy} onConfirm={() => void p.send("/api/claims/remove")} />
        ) : (
          button(T.remove, "/api/claims/remove")
        )}
      </div>
      <PublishControls verified={c.status === "verified"} site={c.site} button={(label, path, primary) => button(label, path, { host: c.host }, primary)} />
      <StatusMessage status={p.status} testId="claim-message" className="mt-2" />
    </li>
  );
}
