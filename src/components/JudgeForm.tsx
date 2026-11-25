"use client";

import { useState, type FormEvent } from "react";
import { JUDGE_UNAVAILABLE, turnOnJudge, type JudgeAnswer } from "./judge";
import { StatusMessage } from "./StatusMessage";
import { useHydrated } from "./useHydrated";

async function post(path: string, body: unknown): Promise<JudgeAnswer> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as { pool?: unknown; message?: unknown } | null;
  return { ok: res.ok, pool: typeof parsed?.pool === "string" ? parsed.pool : null, message: typeof parsed?.message === "string" ? parsed.message : null };
}

export function JudgeForm() {
  const hydrated = useHydrated();
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const code = String(new FormData(form).get("code") ?? "").trim();
    if (!code) {
      setStatus({ ok: false, text: "Enter the judge code." });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const judge = await turnOnJudge(post, code);
      setStatus(judge);
      if (judge.ok) form.reset();
    } catch {
      setStatus({ ok: false, text: JUDGE_UNAVAILABLE });
    }
    setBusy(false);
  }

  return (
    <form method="post" onSubmit={submit} className="mt-8 flex flex-col gap-2" noValidate>
      <label htmlFor="judge-code" className="font-medium">
        Judge code
      </label>
      <div className="flex gap-2">
        <input
          id="judge-code"
          name="code"
          type="password"
          autoComplete="off"
          className="min-w-0 flex-1 rounded border px-3 py-2"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
          aria-describedby="judge-code-status"
        />
        <button
          type="submit"
          disabled={busy || !hydrated}
          className="rounded px-4 py-2 font-medium"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
        >
          {busy ? "Checking…" : "Turn on judge access"}
        </button>
      </div>
      <StatusMessage status={status} id="judge-code-status" />
    </form>
  );
}
