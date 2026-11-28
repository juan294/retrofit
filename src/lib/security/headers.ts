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

/**
 * Retrofit's own public agent files (`pnpm agent:build`). Other sites' runtimes and
 * check_partner.mjs read them from another origin, so each one allows every origin.
 * The private previews under /p/ never get CORS; a published site's JSON files set their own (src/lib/publish/files.ts).
 */
const PUBLIC_AGENT_FILES = [
  "/agent-manifest.json",
  "/retrofit_guide.network.json",
  "/retrofit_conformance.network.json",
  "/links.json",
  "/agent-mcp.json",
  "/.well-known/nsdeploy.json",
  "/.well-known/nsdeploy-agent.json",
] as const;

/** Headers applied by next.config.ts to responses that the request hook does not set. */
export function staticSecurityHeaders(): HeaderRule[] {
  return [
    { source: "/:path*", headers: BASE_HEADERS.map((h) => ({ ...h })) },
    // The sign-in link's page carries the token in its URL: no Referer leaves it (a later rule wins).
    { source: "/auth/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ...PUBLIC_AGENT_FILES.map((source) => ({ source, headers: [{ key: "Access-Control-Allow-Origin", value: "*" }] })),
    { source: "/bridge/:path*", headers: [{ key: "Content-Security-Policy", value: BRIDGE_CSP }] },
    { source: "/p/:id/bridge/:path*", headers: [{ key: "Content-Security-Policy", value: BRIDGE_CSP }] },
    // One file, as src/proxy.ts skips one file: a deeper path keeps the page policy.
    { source: "/s/:host/bridge/:file", headers: [{ key: "Content-Security-Policy", value: BRIDGE_CSP }] },
    { source: "/runtime/sandbox-worker.js", headers: [{ key: "Content-Security-Policy", value: SANDBOX_WORKER_CSP }] },
  ];
}
