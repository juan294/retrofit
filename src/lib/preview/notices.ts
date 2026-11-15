import { BLOCKED_TEXT } from "./fetch-guard";

/**
 * Visible notices for runtime outcomes that the unchanged runtime reports only
 * as trace events or tool results (research 2026-11-15-phase-4-entry.md §7):
 * a prevented loop, a reached call limit, a failed peer network load, a policy
 * refusal and a request the fetch guard blocked.
 */
export interface Notice {
  readonly kind: "loop" | "limit" | "error" | "denied" | "blocked";
  readonly text: string;
}

type TraceEvent = Record<string, unknown> | null | undefined;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function noticeForTrace(ev: TraceEvent): Notice | null {
  if (!ev) return null;
  const kind = str(ev.kind);
  if (ev.phase === "note" && kind === "composition_skip") {
    return { kind: "loop", text: `Retrofit skipped a call back to ${str(ev.target)} to prevent a loop.` };
  }
  if (ev.phase === "note" && kind === "composition_limit") {
    return { kind: "limit", text: `Retrofit stopped a call because this turn reached the runtime's limit: ${str(ev.reason)}.` };
  }
  if (ev.phase !== "end" || ev.status !== "error") return null;
  const error = str(ev.error);
  const blocked = /^Retrofit blocked a request to (\S+) that was not approved\./.exec(error);
  if (blocked) return { kind: "blocked", text: BLOCKED_TEXT(blocked[1]!) };
  if (kind === "remote_fetch") return { kind: "error", text: `Retrofit could not load the network from ${str(ev.peerOrigin)}: ${error}` };
  const policy = /^Policy: (\S+) is not in .+ allowed_peers/.exec(error);
  if (kind === "tool" && policy) return { kind: "denied", text: `Retrofit refused to contact ${policy[1]} because this agent does not allow it.` };
  return null;
}
