import { Resolver } from "node:dns/promises";

/**
 * Reads the TXT records of a DNS name: one array of strings per record (a long record arrives as
 * several strings). Throws an error with a DNS `code` (ENOTFOUND, ENODATA, ESERVFAIL, ...).
 * Injectable on ServerDeps so tests never use real DNS.
 */
export type TxtResolver = (name: string) => Promise<string[][]>;

/** Seconds per query and attempts: a slow name server costs at most about 10 s. */
const DNS_TIMEOUT_MS = 5000;
const DNS_TRIES = 2;

let resolver: Resolver | undefined;

/** The system's name servers (production). */
export const systemTxtResolver: TxtResolver = (name) => {
  resolver ??= new Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES });
  return resolver.resolveTxt(name);
};

/** True for "the name or its TXT data does not exist" (as opposed to a lookup that failed). */
export function isNoRecord(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "ENOTFOUND" || code === "ENODATA";
}
