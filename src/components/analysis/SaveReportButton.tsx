"use client";

import { useState } from "react";
import { SAVE_REPORT_TEXT as T } from "@/lib/site/account-texts";
import { PLAN_TEXT } from "@/lib/site/billing-texts";
import { useHydrated } from "../useHydrated";

type Status = { readonly ok: boolean; readonly text: string; readonly href?: string; readonly linkText?: string } | null;


/** "Save this report" for a signed-in visitor: copies the ready report to the account (POST /api/account/reports). */
export function SaveReportButton({ analysisId }: { analysisId: string }) {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const hydrated = useHydrated();

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/account/reports", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ analysisId }),
      });
      const body = (await res.json().catch(() => null)) as { message?: unknown; href?: unknown } | null;
      const link = res.ok ? { href: "/account", linkText: T.openAccount } : body?.href === "/pricing" ? { href: "/pricing", linkText: PLAN_TEXT.seePlans } : {};
      setStatus({ ok: res.ok, text: typeof body?.message === "string" ? body.message : T.unavailable, ...link });
      if (res.ok) setSaved(true);
    } catch {
      setStatus({ ok: false, text: T.unavailable });
    }
    setBusy(false);
  }

  return (
    <div className="mt-8 flex flex-col items-start gap-2" data-testid="save-report">
      <button
        type="button"
        onClick={save}
        disabled={busy || saved || !hydrated}
        className="rounded px-4 py-2 font-medium"
        style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
      >
        {busy ? T.busy : T.button}
      </button>
      {status ? (
        <p role={status.ok ? "status" : "alert"} style={status.ok ? undefined : { color: "var(--color-danger)" }}>
          {status.text}{" "}
          {status.href ? (
            <a href={status.href} className="underline">
              {status.linkText}
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
