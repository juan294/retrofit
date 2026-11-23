import { PLAN_TEXT } from "@/lib/site/plan-texts";
import { localizeRetry } from "./analysis/retry-time";

/** The fields that Retrofit's own JSON answers share. */
interface AnswerFields {
  readonly message?: unknown;
  readonly retryAt?: unknown;
  readonly href?: unknown;
}

export interface PostAnswer<T> {
  /** 0 when the request did not reach the server. */
  readonly status: number;
  readonly ok: boolean;
  readonly body: (T & AnswerFields) | null;
}

/** What a page shows of an answer (StatusMessage). */
export interface Status {
  readonly ok: boolean;
  readonly text: string;
  readonly href?: string;
  readonly linkText?: string;
}

/** Posts JSON to one of Retrofit's own routes. Never throws. */
export async function postJson<T = object>(path: string, body: unknown): Promise<PostAnswer<T>> {
  try {
    const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, ok: res.ok, body: (await res.json().catch(() => null)) as PostAnswer<T>["body"] };
  } catch {
    return { status: 0, ok: false, body: null };
  }
}

/** The answer's message, with a refusal's retry time in the visitor's own zone and the plans link it names; `unavailable` without a message. */
export function statusOf({ ok, body }: PostAnswer<unknown>, unavailable: string): Status {
  const message = typeof body?.message === "string" ? body.message : unavailable;
  const text = ok ? message : localizeRetry(message, typeof body?.retryAt === "string" ? body.retryAt : undefined);
  return { ok, text, ...(body?.href === "/pricing" ? { href: "/pricing", linkText: PLAN_TEXT.seePlans } : {}) };
}
