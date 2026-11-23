/** Where sign-in returns when the page it started from is unknown or not allowed. */
export const DEFAULT_RETURN = "/account";

const MAX_LENGTH = 512;
/** True when `s` has a C0 control character or DEL. */
const hasControl = (s: string) => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const BASE = "https://retrofit.invalid";
/** Sign-in never returns to an API route or to the confirm route itself. */
const REFUSED_PREFIXES = ["/api/", "/auth/"];

/**
 * The same-origin path (with its query) that sign-in returns to, or DEFAULT_RETURN.
 * Refuses absolute URLs, schemes, protocol-relative `//` paths, backslashes and
 * control characters. Callers still prefix PUBLIC_ORIGIN, so a value that slipped
 * past these checks could only name a path on Retrofit itself.
 */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LENGTH) return DEFAULT_RETURN;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || hasControl(raw)) return DEFAULT_RETURN;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return DEFAULT_RETURN;
  }
  if (url.origin !== BASE) return DEFAULT_RETURN;
  const path = `${url.pathname}${url.search}`;
  if (path !== raw.replace(/#.*$/, "") || REFUSED_PREFIXES.some((p) => url.pathname.startsWith(p))) return DEFAULT_RETURN;
  return path;
}
