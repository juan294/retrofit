"use client";

import { useState } from "react";
import { SAVE_REPORT_TEXT as T } from "@/lib/site/account-texts";
import { postJson, statusOf, type Status } from "../post";
import { StatusMessage } from "../StatusMessage";
import { useHydrated } from "../useHydrated";
import { buttonState, useOneAtATime } from "../useOneAtATime";

/** "Save this report" for a signed-in visitor: copies the ready report to the account (POST /api/account/reports). */
export function SaveReportButton({ analysisId }: { analysisId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const { busy, run } = useOneAtATime();
  const [saved, setSaved] = useState(false);
  const hydrated = useHydrated();

  function save() {
    if (saved) return;
    void run("save", async () => {
      setStatus(null);
      const answer = await postJson("/api/account/reports", { analysisId });
      setStatus({ ...statusOf(answer, T.unavailable, `/r/${analysisId}`), ...(answer.ok ? { href: "/account", linkText: T.openAccount } : {}) });
      if (answer.ok) setSaved(true);
    });
  }

  return (
    <div className="mt-8 flex flex-col items-start gap-2" data-testid="save-report">
      <button
        type="button"
        onClick={save}
        {...buttonState(hydrated, busy !== null || saved)}
        className="rounded px-4 py-2 font-medium"
        style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
      >
        {busy ? T.busy : T.button}
      </button>
      <StatusMessage status={status} />
    </div>
  );
}
