import { hashToken, TOKEN_PATTERN, type AccountData } from "@/lib/accounts/data";
import type { ServerDeps } from "@/lib/server/runtime";
import { UNSUBSCRIBE_TEXT } from "@/lib/site/pricing-texts";
import { readLimitedBody } from "./body";
import { json } from "./json";

/** `done`: the address is unsubscribed (now or earlier). `invalid`: no signup has this link. `unavailable`: try later. */
export type UnsubscribeOutcome = "done" | "invalid" | "unavailable";

const OUTCOMES: readonly UnsubscribeOutcome[] = ["done", "invalid", "unavailable"];

export const UNSUBSCRIBE_MAX_BODY_BYTES = 2048;

/**
 * Records the unsubscribe time once. A second call answers `done` again and
 * changes nothing. A missing, malformed or unknown token answers `invalid` and
 * reveals no address. The token is never logged.
 */
export async function unsubscribeByToken(t: string | string[] | undefined | null, accounts: AccountData): Promise<UnsubscribeOutcome> {
  if (typeof t !== "string" || !TOKEN_PATTERN.test(t)) return "invalid";
  try {
    return (await accounts.unsubscribe(hashToken(t))) === "unknown" ? "invalid" : "done";
  } catch (e) {
    console.error("unsubscribe failed:", e instanceof Error ? e.name : "unknown error");
    return "unavailable";
  }
}

export type UnsubscribePageState = { readonly kind: "confirm"; readonly token: string } | { readonly kind: "result"; readonly outcome: UnsubscribeOutcome };

/**
 * GET /unsubscribe: what the page shows. It never reads or writes account data,
 * because mail link scanners open every link in a message: `?t=<token>` shows a
 * confirm form, `?result=<outcome>` (after the form's 303) shows that outcome's text.
 */
export function unsubscribePageState(params: Record<string, string | string[] | undefined>): UnsubscribePageState {
  const { t, result } = params;
  if (typeof result === "string") return { kind: "result", outcome: OUTCOMES.find((o) => o === result) ?? "invalid" };
  if (typeof t === "string" && TOKEN_PATTERN.test(t)) return { kind: "confirm", token: t };
  return { kind: "result", outcome: "invalid" };
}

async function formFields(request: Request, text: string): Promise<FormData | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)\b/i.test(type)) return null;
  try {
    return await new Response(text, { headers: { "content-type": type } }).formData();
  } catch {
    return null;
  }
}

/**
 * POST /api/unsubscribe, two callers:
 * - the confirm form on /unsubscribe (`t` in the urlencoded body): 303 to
 *   /unsubscribe?result=<outcome>;
 * - RFC 8058 one-click from a mail provider (`List-Unsubscribe=One-Click` in the
 *   body, the token in `?t=`): 200 with one answer for known and unknown tokens,
 *   503 when account data is unavailable.
 * Not same-origin only: a mail provider posts from its own servers, and the
 * token is the authorization. Idempotent. Body at most 2 KB (413); any other body 400.
 */
export async function handleUnsubscribePost(request: Request, deps: Pick<ServerDeps, "config" | "accounts">): Promise<Response> {
  const text = await readLimitedBody(request, UNSUBSCRIBE_MAX_BODY_BYTES);
  if (text === "too large") return json(413, { error: "too_large", message: "That request is too large." });
  const form = await formFields(request, text);
  const formToken = form?.get("t");
  if (typeof formToken === "string") {
    const outcome = await unsubscribeByToken(formToken, deps.accounts);
    return new Response(null, { status: 303, headers: { location: `${deps.config.publicOrigin}/unsubscribe?result=${outcome}`, "cache-control": "no-store" } });
  }
  if (form?.get("List-Unsubscribe") === "One-Click") {
    const outcome = await unsubscribeByToken(new URL(request.url).searchParams.get("t"), deps.accounts);
    if (outcome === "unavailable") return json(503, { error: "unavailable", message: UNSUBSCRIBE_TEXT.unavailable });
    return json(200, { ok: true, message: UNSUBSCRIBE_TEXT.oneClick });
  }
  return json(400, { error: "bad_request", message: "Use the unsubscribe button on the page the link opens." });
}
