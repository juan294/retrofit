import type { Config } from "../config";

export interface PhaseOrigins {
  /** Exact origins that every deployment may contact (later phases add router and peer origins). */
  readonly origins?: readonly string[];
  /** Exact origins added only when fixtures are enabled (test servers). */
  readonly fixtureOrigins?: readonly string[];
}

function exactOrigin(value: string): string {
  const u = new URL(value);
  if (u.origin !== value.replace(/\/$/, "") || value.includes("*")) {
    throw new Error(`connect-src entry must be an exact origin: ${value}`);
  }
  return u.origin;
}

/** The single place that decides which origins the page may connect to. */
export function buildConnectSrc(config: Pick<Config, "fixturesEnabled">, phase: PhaseOrigins = {}): string[] {
  const list = ["'self'"];
  const add = (o: string) => {
    const origin = exactOrigin(o);
    if (!list.includes(origin)) list.push(origin);
  };
  for (const o of phase.origins ?? []) add(o);
  if (config.fixturesEnabled) for (const o of phase.fixtureOrigins ?? []) add(o);
  return list;
}

export interface PageCspOptions {
  readonly dev?: boolean;
  readonly phase?: PhaseOrigins;
}

export function pageCsp(config: Pick<Config, "fixturesEnabled">, nonce: string, options: PageCspOptions = {}): string {
  const script = ["'self'", `'nonce-${nonce}'`];
  if (options.dev) script.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${buildConnectSrc(config, options.phase).join(" ")}`,
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

export const BASE_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
] as const;

export const BRIDGE_CSP = "script-src 'self'; frame-ancestors *";
export const SANDBOX_WORKER_CSP = "default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'";

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/** Headers applied by next.config.ts to responses that the request hook does not set. */
export function staticSecurityHeaders(): HeaderRule[] {
  return [
    { source: "/:path*", headers: BASE_HEADERS.map((h) => ({ ...h })) },
    { source: "/bridge/:path*", headers: [{ key: "Content-Security-Policy", value: BRIDGE_CSP }] },
    { source: "/p/:id/bridge/:path*", headers: [{ key: "Content-Security-Policy", value: BRIDGE_CSP }] },
    { source: "/runtime/sandbox-worker.js", headers: [{ key: "Content-Security-Policy", value: SANDBOX_WORKER_CSP }] },
  ];
}
