// Reads a fetched /agent-manifest.json probe. The body is untrusted data: nothing
// here is echoed back except Retrofit's own wording.

import type { Probe } from "@/lib/snapshot/types";

export interface DeclaredNetwork {
  name: string;
  front_man: string;
  hocon: string;
}

export type ManifestReading =
  | { kind: "not-read" }
  | { kind: "status"; status: number }
  | { kind: "not-json" }
  | { kind: "no-network" }
  | { kind: "incomplete"; missing: ("name" | "front_man" | "hocon")[] }
  | { kind: "ok"; network: DeclaredNetwork };

const ok = (status: number | null): status is number => status !== null && status >= 200 && status < 300;

/** Judge the manifest by its first network entry, the one the organizers' runtime loads (engine.js `manifest.networks[0]`). */
export function readManifest(probe: Probe): ManifestReading {
  if (probe.status === null) return { kind: "not-read" };
  if (!ok(probe.status)) return { kind: "status", status: probe.status };
  let parsed: unknown;
  try {
    parsed = JSON.parse(probe.body ?? "");
  } catch {
    return { kind: "not-json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "not-json" };
  const networks = (parsed as { networks?: unknown }).networks;
  const first: unknown = Array.isArray(networks) ? networks[0] : undefined;
  if (typeof first !== "object" || first === null || Array.isArray(first)) return { kind: "no-network" };
  const entry = first as Record<string, unknown>;
  const missing = (["name", "front_man", "hocon"] as const).filter((k) => typeof entry[k] !== "string" || (entry[k] as string).trim() === "");
  if (missing.length) return { kind: "incomplete", missing };
  return { kind: "ok", network: { name: entry.name as string, front_man: entry.front_man as string, hocon: entry.hocon as string } };
}

/** The http(s) URL of the declared network, resolved against the manifest URL; null when there is none. */
export function declaredNetworkUrl(probe: Probe): URL | null {
  const reading = readManifest(probe);
  if (reading.kind !== "ok") return null;
  try {
    const url = new URL(reading.network.hocon.trim(), probe.url);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
