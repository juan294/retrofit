/**
 * The performance test's oracle for one GET /api/analyze/[id] response in
 * fixtures mode (validation V15). It refuses, instead of reading as zero or
 * as success: a non-200 response, missing or non-numeric telemetry, a failed
 * or expired analysis, and a `ready` status without a usable score.
 */

import type { StoreWork } from "@/lib/store/counting";

const STATUSES = new Set(["queued", "crawling", "ready"]);

/** The dispatch part of the status route's `x-retrofit-store-work` header. */
export type DispatchWork = NonNullable<StoreWork["dispatch"]>;

export interface StatusSample {
  readonly status: string;
  readonly scoreReady: boolean;
  /** Analysis and job reads of the request. */
  readonly reads: number;
  /** Every store operation of the request itself. */
  readonly foregroundOps: number;
  /** The background dispatch the request started, counted until it resolved. */
  readonly dispatch: DispatchWork;
}

/** A non-negative integer: a JSON number, or with `fromHeader` a header string of digits. */
function count(value: unknown, what: string, fromHeader = false): number {
  const n = fromHeader ? (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN) : typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${what} is not a non-negative integer: ${JSON.stringify(value)}`);
  return n;
}

export function parseStatusSample(httpStatus: number, headers: Headers, body: unknown): StatusSample {
  if (httpStatus !== 200) throw new Error(`status request answered HTTP ${httpStatus}: ${JSON.stringify(body)}`);
  const reads = count(headers.get("x-retrofit-store-reads"), "x-retrofit-store-reads", true);
  const raw = headers.get("x-retrofit-store-work");
  if (raw === null) throw new Error("x-retrofit-store-work is missing");
  let work: { foreground?: unknown; dispatch?: unknown };
  try {
    work = JSON.parse(raw) as typeof work;
  } catch {
    throw new Error(`x-retrofit-store-work is not JSON: ${raw}`);
  }
  const foregroundOps = count(work.foreground, "x-retrofit-store-work foreground");
  const d = work.dispatch as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object") throw new Error(`x-retrofit-store-work dispatch is missing (a 404 or a failed dispatch): ${raw}`);
  const dispatch: DispatchWork = {
    started: count(d.started, "x-retrofit-store-work dispatch.started"),
    operations: count(d.operations, "x-retrofit-store-work dispatch.operations"),
    claims: count(d.claims, "x-retrofit-store-work dispatch.claims"),
  };
  const b = body as { status?: unknown; scoreReady?: unknown } | null;
  if (!b || typeof b.status !== "string") throw new Error(`status body has no status: ${JSON.stringify(body)}`);
  if (typeof b.scoreReady !== "boolean") throw new Error(`status body has no boolean scoreReady: ${JSON.stringify(body)}`);
  if (!STATUSES.has(b.status)) throw new Error(`analysis ${b.status}: ${JSON.stringify(body)}`);
  if (b.status === "ready" && !b.scoreReady) throw new Error(`ready without a score: ${JSON.stringify(body)}`);
  return { status: b.status, scoreReady: b.scoreReady, reads, foregroundOps, dispatch };
}

/** A finished analysis: ready with a readable score. */
export function isComplete(s: StatusSample): boolean {
  return s.status === "ready" && s.scoreReady;
}
