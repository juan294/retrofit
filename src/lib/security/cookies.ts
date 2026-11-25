/** Retrofit's cookies: one reader and one Set-Cookie builder, so every cookie has the same attribute order. */

/** The value of the first cookie `name` in a Cookie header, trimmed, or null. */
export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * The name a cookie has on this deployment. Over https it carries the `__Host-` prefix: browsers then accept it
 * only from this exact host (Secure, Path=/, no Domain), so a cookie that another subdomain sets for the parent
 * domain never counts. Browsers refuse the prefix on plain http (local development, browser tests).
 */
export function hostCookieName(name: string, config: { readonly publicOrigin: string }): string {
  return config.publicOrigin.startsWith("https:") ? `__Host-${name}` : name;
}

export interface CookieOptions {
  readonly path: string;
  /** Seconds; 0 clears the cookie. */
  readonly maxAge: number;
  readonly secure: boolean;
  /** Default Lax. */
  readonly sameSite?: "Lax" | "Strict";
}

/** `name=value; HttpOnly; SameSite=<s>; Path=<p>; Max-Age=<n>[; Secure]`. Every Retrofit cookie is HttpOnly. */
export function buildCookie(name: string, value: string, o: CookieOptions): string {
  const attrs = [`${name}=${value}`, "HttpOnly", `SameSite=${o.sameSite ?? "Lax"}`, `Path=${o.path}`, `Max-Age=${o.maxAge}`];
  if (o.secure) attrs.push("Secure");
  return attrs.join("; ");
}
