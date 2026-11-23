import type { ApiKey } from "@/lib/accounts/data";
import { API_KEY_CREATES_PER_HOUR } from "@/lib/accounts/limits";
import { newApiKey } from "@/lib/billing/api-keys";
import type { ServerDeps } from "@/lib/server/runtime";
import { dateText } from "@/lib/site/account-texts";
import { API_KEY_TEXT as T } from "@/lib/site/billing-texts";
import { accountPost } from "./account-post";
import { refuseFeature } from "./entitled";
import { json } from "./json";
import { countIn } from "./limits";

type Deps = Pick<ServerDeps, "config" | "store" | "accounts" | "billing" | "clock">;

/** A key as the account page shows it. */
export interface ApiKeyView {
  readonly id: string;
  readonly hint: string | null;
  readonly createdOn: string;
}

export const apiKeyView = (key: ApiKey): ApiKeyView => ({ id: key.id, hint: key.hint, createdOn: dateText(key.createdAt) });

/**
 * POST /api/account/keys -> 201 `{key, apiKey, message}`: a new API key, the only time it is ever shown.
 * An accountPost; 403 plan_required or 503 billing_unavailable (entitled.ts), 429 limit past
 * API_KEY_CREATES_PER_HOUR creations of the account in the hour, 409 full (MAX_API_KEYS).
 */
export function handleCreateKey(request: Request, deps: Deps): Promise<Response> {
  return accountPost("/api/account/keys", T, request, deps, async ({ accountId }) => {
    const refused = (await refuseFeature(deps, accountId, "api_keys")) ?? (await countIn(deps, "api-key-create", API_KEY_CREATES_PER_HOUR, accountId, T.limit));
    if (refused) return refused;
    const { key, stored } = newApiKey();
    const created = await deps.accounts.createApiKey(accountId, stored);
    if (created.outcome === "full") return json(409, { error: "full", message: T.full });
    return json(201, { key, apiKey: apiKeyView(created.key), message: T.created });
  });
}

/** POST /api/account/keys/revoke `{keyId}` -> 200 `{message}`, or 404 not_found for a key that is not an active one of the account. Needs no plan. */
export function handleRevokeKey(request: Request, deps: Deps): Promise<Response> {
  return accountPost("/api/account/keys/revoke", T, request, deps, async ({ accountId }, { keyId }) => {
    const revoked = typeof keyId === "string" && (await deps.accounts.revokeApiKey(accountId, keyId));
    return revoked ? json(200, { message: T.revoked }) : json(404, { error: "not_found", message: T.notFound });
  });
}
