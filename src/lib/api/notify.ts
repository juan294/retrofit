import { normalizeEmail } from "@/lib/accounts/data";
import { isSameOrigin } from "@/lib/analysis/run";
import { hhmmUtc } from "@/lib/analysis/texts";
import { clientIdFromRequest, countClientWindow } from "@/lib/fetch/limits";
import type { ServerDeps } from "@/lib/server/runtime";
import { REQUEST_TEXT } from "@/lib/site/pricing-texts";
import { readSmallBody } from "./body";
import { json } from "./json";

export const notifyTexts = {
  onTheList: "You're on the list. We will email you when paid plans start.",
  crossOrigin: "Open Retrofit at its own address to join the list.",
  invalidEmail: "Enter a valid email address.",
  limit: (limit: number, retryAt: Date) => `You reached the limit of ${limit} signups per hour. Try again at ${hhmmUtc(retryAt)} UTC.`,
} as const;

interface NotifyBody {
  readonly email: string;
  readonly consent: boolean;
}

function parse(text: string): NotifyBody | null {
  try {
    const body = JSON.parse(text) as { email?: unknown; consent?: unknown } | null;
    if (typeof body !== "object" || body === null || Array.isArray(body) || typeof body.email !== "string") return null;
    const email = normalizeEmail(body.email);
    // Consent is an explicit tick only: anything but `true` (missing, "true", 1) is no consent.
    return email === null ? null : { email, consent: body.consent === true };
  } catch {
    return null;
  }
}

/**
 * POST /api/notify `{email, consent?}` -> 200 with the same body for a new and
 * a repeat signup, so the answer never tells whether an address is on the list.
 * Same-origin only (403). Errors: 413 too_large (over 2 KB), 400 invalid_email,
 * 429 limit `{error, message, retryAt}` (NOTIFY_PER_CLIENT_HOUR per network per
 * hour, every valid request counted), 503 unavailable. The address is never
 * logged. Phase 1 sends no mail; the unsubscribe token of a new signup is kept
 * only as its hash until a mailer exists.
 */
export async function handleNotify(request: Request, deps: Pick<ServerDeps, "config" | "store" | "accounts" | "clock">): Promise<Response> {
  if (!isSameOrigin(request, deps.config)) return json(403, { error: "cross_origin", message: notifyTexts.crossOrigin });
  try {
    const text = await readSmallBody(request);
    if (text === "too large") return json(413, { error: "too_large", message: REQUEST_TEXT.tooLarge });
    const body = parse(text);
    if (body === null) return json(400, { error: "invalid_email", message: notifyTexts.invalidEmail });

    const now = deps.clock();
    const limit = await countClientWindow(deps.store, "notify-window", deps.config.notifyPerClientHour, clientIdFromRequest(request, deps.config, now), now);
    if (!limit.ok) {
      const retryAt = new Date(limit.retryAt);
      return json(429, { error: "limit", message: notifyTexts.limit(deps.config.notifyPerClientHour, retryAt), retryAt: retryAt.toISOString() });
    }

    await deps.accounts.addNotifySignup(body.email, body.consent);
    return json(200, { ok: true, message: notifyTexts.onTheList });
  } catch (e) {
    // The error name only: a database message can quote the address.
    console.error("POST /api/notify failed:", e instanceof Error ? e.name : "unknown error");
    return json(503, { error: "unavailable", message: REQUEST_TEXT.unavailable });
  }
}
