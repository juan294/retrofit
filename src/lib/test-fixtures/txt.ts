import type { TxtResolver } from "@/lib/claims/txt";

// Fixtures mode only: the TXT records browser tests publish for DNS claims (POST /test-fixtures/txt).
// The server's TXT resolver reads them; every other name answers ENOTFOUND, so fixtures mode never
// uses real DNS. Production never reads it (getServerDeps uses the system resolver off fixtures mode).
const records = new Map<string, string[][]>();

/** Replaces the records of `name`; an empty list removes the name. */
export function setFixtureTxt(name: string, value: string[][]): void {
  if (value.length === 0) records.delete(name);
  else records.set(name, value.map((r) => [...r]));
}

export const fixtureTxtResolver: TxtResolver = async (name) => {
  const found = records.get(name);
  if (!found) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: "ENOTFOUND" });
  return found.map((r) => [...r]);
};
