"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { localizeRetry } from "./analysis/retry-time";
import { createStartController, type StartController, type StartState } from "./analysis/start-controller";

export function UrlForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [{ busy, waiting }, setState] = useState<StartState>({ busy: false, waiting: null });
  const starts = useRef<StartController | null>(null);

  // One start at a time; leaving the page aborts it, so a late answer never navigates.
  useEffect(() => {
    const controller = createStartController({
      onState: setState,
      onResult: (r) => (r.ok ? router.push(`/r/${r.id}`) : setError(localizeRetry(r.failure.message, r.failure.retryAt))),
    });
    starts.current = controller;
    return () => controller.dispose();
  }, [router]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const url = String(new FormData(event.currentTarget).get("url") ?? "").trim();
    if (!url) {
      setError("Paste the address of a public website.");
      return;
    }
    starts.current?.start(url);
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
      {/* Always mounted, so a screen reader announces the text when it appears. */}
      <p role="status">{waiting ?? ""}</p>
      {error ? (
        <p id="site-url-error" role="alert" style={{ color: "var(--color-danger)" }}>
          {error}
        </p>
      ) : null}
    </form>
  );
}
