import { COUNTING_RETRY_S, visitorTexts } from "@/lib/analysis/texts";

export interface RequestFailure {
  readonly code: string;
  readonly message: string;
  readonly retryAt?: string;
}

export type AnalysisRequestResult = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly failure: RequestFailure };

export interface RequestOptions {
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called before each automatic retry, with the text to show while the page waits. */
  readonly onRetry?: (message: string) => void;
  /** Attempts in all while the answer is `counting`. Default COUNTING_ATTEMPTS. */
  readonly attempts?: number;
  /** Aborts the request and any retry wait; the result is then the `aborted` failure. */
  readonly signal?: AbortSignal;
}

/**
 * Attempts for one start, the first included, while the site's daily count is
 * undecided (503 `counting`). Each attempt counts against the visitor's hourly
 * limit, so the page stops after a few and shows the server's text.
 */
export const COUNTING_ATTEMPTS = 3;

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** The result of an aborted start. The page that aborted it is gone and shows nothing. */
const ABORTED: AnalysisRequestResult = { ok: false, failure: { code: "aborted", message: visitorTexts.unavailable } };

interface AnalyzeBody {
  id?: unknown;
  error?: unknown;
  message?: unknown;
  retryAt?: unknown;
  retryAfterSeconds?: unknown;
}

/**
 * POST /api/analyze `{url}`. A 503 `counting` answer (another request for the
 * site is still starting, so nothing was started) is retried by itself after
 * its `retryAfterSeconds`, up to `attempts` (COUNTING_ATTEMPTS) in all. Every other
 * answer is returned at once. After `signal` aborts, nothing else is sent and
 * the result is the `aborted` failure, never an id.
 */
export async function requestAnalysis(url: string, o: RequestOptions = {}): Promise<AnalysisRequestResult> {
  const send = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => realSleep(ms, o.signal));
  const attempts = o.attempts ?? COUNTING_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    if (o.signal?.aborted) return ABORTED;
    let res: Response;
    let body: AnalyzeBody | null;
    try {
      res = await send("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ url }),
        signal: o.signal,
      });
      body = (await res.json().catch(() => null)) as AnalyzeBody | null;
    } catch {
      return o.signal?.aborted ? ABORTED : { ok: false, failure: { code: "unavailable", message: visitorTexts.unavailable } };
    }
    if (o.signal?.aborted) return ABORTED;
    if (res.ok && typeof body?.id === "string") return { ok: true, id: body.id };
    if (res.status === 503 && body?.error === "counting" && attempt < attempts) {
      const seconds = typeof body.retryAfterSeconds === "number" && body.retryAfterSeconds > 0 ? body.retryAfterSeconds : COUNTING_RETRY_S;
      o.onRetry?.(visitorTexts.countingRetry);
      await sleep(seconds * 1000);
      continue;
    }
    const message = typeof body?.message === "string" ? body.message : visitorTexts.unavailable;
    const code = typeof body?.error === "string" && typeof body?.message === "string" ? body.error : "unavailable";
    return { ok: false, failure: { code, message, ...(typeof body?.retryAt === "string" ? { retryAt: body.retryAt } : {}) } };
  }
}
