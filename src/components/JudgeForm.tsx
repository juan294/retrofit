"use client";

import { useState, type FormEvent } from "react";

const UNAVAILABLE = "Judge access is not available right now. Try again in a minute.";

async function post(path: string, body?: unknown): Promise<{ ok: boolean; message: string | null }> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as { message?: unknown } | null;
  return { ok: res.ok, message: typeof parsed?.message === "string" ? parsed.message : null };
}

export function JudgeForm() {
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
      const session = await post("/api/inference/session");
      if (!session.ok) {
        setStatus({ ok: false, text: session.message ?? UNAVAILABLE });
      } else {
        const judge = await post("/api/inference/session/judge", { code });
        setStatus(judge.ok ? { ok: true, text: "Judge access is on for this browser." } : { ok: false, text: judge.message ?? UNAVAILABLE });
        if (judge.ok) form.reset();
      }
    } catch {
      setStatus({ ok: false, text: UNAVAILABLE });
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="mt-8 flex flex-col gap-2" noValidate>
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
          aria-describedby={status ? "judge-code-status" : undefined}
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded px-4 py-2 font-medium"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
        >
          {busy ? "Checking…" : "Turn on judge access"}
        </button>
      </div>
      {status ? (
        <p id="judge-code-status" role={status.ok ? "status" : "alert"} style={status.ok ? undefined : { color: "var(--color-danger)" }}>
          {status.text}
        </p>
      ) : null}
    </form>
  );
}
