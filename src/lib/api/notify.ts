import { normalizeEmail } from "@/lib/accounts/data";
import { isSameOrigin } from "@/lib/analysis/run";
import { hhmmUtc } from "@/lib/analysis/texts";
import { clientIdFromRequest, clientWindow, ttlUntil } from "@/lib/fetch/limits";
import type { ServerDeps } from "@/lib/server/runtime";
import { readLimitedBody } from "./body";
import { json } from "./json";

export const NOTIFY_MAX_BODY_BYTES = 2048;

export const notifyTexts = {
  onTheList: "You're on the list. We will email you when paid plans start.",
  crossOrigin: "Open Retrofit at its own address to join the list.",
  tooLarge: "That request is too large.",
  invalidEmail: "Enter a valid email address.",
  limit: (limit: number, retryAt: Date) => `You reached the limit of ${limit} signups per hour. Try again at ${hhmmUtc(retryAt)} UTC.`,
  unavailable: "Retrofit could not save your address. Try again in a few minutes.",
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
    const text = await readLimitedBody(request, NOTIFY_MAX_BODY_BYTES);
    if (text === "too large") return json(413, { error: "too_large", message: notifyTexts.tooLarge });
    const body = parse(text);
    if (body === null) return json(400, { error: "invalid_email", message: notifyTexts.invalidEmail });

    const now = deps.clock();
    const { bucket, endsAt } = clientWindow(now);
    const clientId = clientIdFromRequest(request, deps.config, now);
    const count = await deps.store.incrementWindow(`notify-window:${clientId}:${bucket}`, ttlUntil(endsAt, now));
    if (count > deps.config.notifyPerClientHour) {
      const retryAt = new Date(endsAt);
      return json(429, { error: "limit", message: notifyTexts.limit(deps.config.notifyPerClientHour, retryAt), retryAt: retryAt.toISOString() });
    }

    await deps.accounts.addNotifySignup(body.email, body.consent);
    return json(200, { ok: true, message: notifyTexts.onTheList });
  } catch (e) {
    // The error name only: a database message can quote the address.
    console.error("POST /api/notify failed:", e instanceof Error ? e.name : "unknown error");
    return json(503, { error: "unavailable", message: notifyTexts.unavailable });
  }
}
