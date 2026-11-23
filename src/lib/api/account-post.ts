import { readAccount, type Account } from "@/lib/accounts/session";
import { isSameOrigin } from "@/lib/analysis/run";
import type { ServerDeps } from "@/lib/server/runtime";
import { readSmallBody } from "./body";
import { json } from "./json";

/** The answers of the shared preconditions, from the caller's copy module. */
export interface AccountPostTexts {
  readonly crossOrigin: string;
  readonly tooLarge: string;
  readonly signedOut: string;
  readonly unavailable: string;
}

export type Fields = Record<string, unknown>;

/**
 * One POST of the account page (claims, publishing): same-origin only (403 cross_origin), a JSON body
 * of at most 2 KB (413 too_large; anything that is not an object counts as empty), a signed-in account
 * (401 signed_out), then `body`. 503 unavailable when the account data or the Store fails.
 */
export async function accountPost(
  name: string,
  texts: AccountPostTexts,
  request: Request,
  deps: Pick<ServerDeps, "config" | "store" | "clock">,
  body: (account: Account, fields: Fields) => Promise<Response>,
): Promise<Response> {
  try {
    if (!isSameOrigin(request, deps.config)) return json(403, { error: "cross_origin", message: texts.crossOrigin });
    const text = await readSmallBody(request);
    if (text === "too large") return json(413, { error: "too_large", message: texts.tooLarge });
    let fields: Fields = {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) fields = parsed as Fields;
    } catch {
      fields = {};
    }
    const account = await readAccount(request, deps);
    if (!account) return json(401, { error: "signed_out", message: texts.signedOut });
    return await body(account, fields);
  } catch (e) {
    console.error(`POST ${name} failed:`, e instanceof Error ? e.name : "unknown error");
    return json(503, { error: "unavailable", message: texts.unavailable });
  }
}
