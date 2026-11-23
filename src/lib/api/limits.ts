import { countClientWindow } from "@/lib/fetch/limits";
import type { ServerDeps } from "@/lib/server/runtime";
import { limitOr429 } from "./json";

/** Counts one call under `key` in its hourly window; null when admitted, else the 429 with `text` past `limit`. */
export async function countIn(deps: Pick<ServerDeps, "store" | "clock">, prefix: string, limit: number, key: string, text: (retryAt: Date) => string): Promise<Response | null> {
  return limitOr429(await countClientWindow(deps.store, prefix, limit, key, deps.clock()), text);
}
