"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function UrlForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const url = String(new FormData(event.currentTarget).get("url") ?? "").trim();
    if (!url) {
      setError("Paste the address of a public website.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ url }),
      });
      const body = (await res.json().catch(() => null)) as { id?: string; message?: string } | null;
      if (res.ok && body?.id) {
        router.push(`/r/${body.id}`);
        return;
      }
      setError(body?.message ?? "Retrofit is having trouble. Try again in a few minutes.");
    } catch {
      setError("Retrofit is having trouble. Try again in a few minutes.");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="mt-8 flex flex-col gap-2" noValidate>
      <label htmlFor="site-url" className="font-medium">
        Your website address
      </label>
      <div className="flex gap-2">
        <input
          id="site-url"
          name="url"
          type="text"
          inputMode="url"
          autoComplete="url"
          placeholder="https://example.com"
          className="min-w-0 flex-1 rounded border px-3 py-2"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
          aria-describedby={error ? "site-url-error" : undefined}
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded px-4 py-2 font-medium"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
        >
          {busy ? "Starting…" : "Score my site"}
        </button>
      </div>
      {error ? (
        <p id="site-url-error" role="alert" style={{ color: "var(--color-danger)" }}>
          {error}
        </p>
      ) : null}
    </form>
  );
}
