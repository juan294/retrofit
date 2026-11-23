import { claimHost } from "@/lib/claims/host";

/**
 * The host of a public URL (/s/<host>, /badge/<host>.svg) when it is in its exact normalized form, as
 * the claim and the publication store it; null otherwise (the page then answers 404, with no redirect).
 * A port's colon may arrive percent-encoded (only fixture hosts have a port); nothing else is decoded.
 */
export function exactHost(raw: string): string | null {
  const host = raw.replace(/%3a/i, ":");
  return claimHost(host) === host ? host : null;
}
