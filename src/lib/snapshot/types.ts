// The Snapshot is Retrofit's saved, public-only copy of a website. It is a superset of the
// organizers' site-content.json (agentic-web skills/agentify-website/references/live_url_mode.md
// step 2), read by the vendored public/preview-assets/content-actions.js. That module reads only:
//   snapshot.source, snapshot.fetchedAt               (content-actions.js:147-148, 170-171)
//   snapshot.pages[].url, .title, .text               (content-actions.js:134-141, 201-203)
//   snapshot.records: {collection: [{id, ...}]}       (content-actions.js:21, 161-164)
// Every string in a Snapshot is plain-text data. Consumers must escape it; it is never markup
// and never an instruction.

export const SNAPSHOT_VERSION = "snapshot/v1";
export const MAX_TEXT_CHARS = 20_000;
export const PROBE_BODY_MAX_CHARS = 65_536;
export const MAX_RECORD_ID_CHARS = 200;
export const MAX_LINKS = 500;
export const MAX_FORMS = 50;
export const MAX_FORM_INPUTS = 100;
export const MAX_JSON_LD_ITEMS = 100;
export const MAX_JSON_DEPTH = 32;

export const KEPT_HEADERS = ["content-type", "x-robots-tag", "access-control-allow-origin"] as const;
export type KeptHeader = (typeof KEPT_HEADERS)[number];
export type KeptHeaders = Partial<Record<KeptHeader, string>>;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type RecordValue = string | string[];

/** One structured item, such as a product or an opening-hours row. `url` is the source page. */
export interface SiteRecord {
  id: string;
  type: string;
  url: string;
  name?: string;
  description?: string;
  [field: string]: RecordValue | undefined;
}

/** Records keyed by collection name, for example `products` or `opening_hours`. */
export type RecordCollections = Record<string, SiteRecord[]>;

export interface FormInput {
  name: string | null;
  type: string;
  label: string | null;
  hidden: boolean;
}

export interface FormExtract {
  method: string;
  action: string;
  inputs: FormInput[];
}

export interface LinkExtract {
  href: string;
  text: string;
  sameHost: boolean;
}

export interface PageExtract {
  url: string;
  title: string;
  description: string | null;
  lang: string | null;
  text: string;
  textTruncated: boolean;
  noindex: boolean;
  headers: KeptHeaders;
  jsonLd: JsonValue[];
  jsonLdInvalid: number;
  forms: FormExtract[];
  links: LinkExtract[];
  records: RecordCollections;
}

export interface SnapshotPage extends PageExtract {
  status: number;
  /** The response body passed the fetch byte limit. */
  truncated: boolean;
}

export interface Probe {
  url: string;
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  contentType: string | null;
  /** At most PROBE_BODY_MAX_CHARS; null when there was no usable body. */
  body: string | null;
  accessControlAllowOrigin: string | null;
}

export interface Probes {
  agentManifest: Probe;
  llmsTxt: Probe;
  sitemap: Probe;
  robots: Probe;
  /** The network file named by the manifest's `networks[0].hocon`; absent when the manifest declares none or it was not read. */
  network?: Probe;
}

export interface SkippedPage {
  url: string;
  reason: string;
}

export interface Snapshot {
  version: typeof SNAPSHOT_VERSION;
  /** site-content.json `source`: the home page URL the snapshot describes. */
  source: string;
  inputUrl: string;
  finalUrl: string;
  host: string;
  /** ISO 8601 timestamp. */
  fetchedAt: string;
  pages: SnapshotPage[];
  probes: Probes;
  skipped: SkippedPage[];
  records: RecordCollections;
  excludedNoindex: string[];
}

/** What an agent's files are generated from (generateNetwork), and all a published site keeps of its pages. */
export interface AgentSnapshot extends Pick<Snapshot, "source" | "host" | "fetchedAt" | "records"> {
  pages: Pick<SnapshotPage, "url" | "title" | "text" | "noindex">[];
}

/** Exactly the organizers' site-content.json shape. */
export interface SiteContent {
  source: string;
  fetchedAt: string;
  pages: { url: string; title: string; text: string }[];
  records: RecordCollections;
}

export class SnapshotValidationError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Invalid snapshot at ${path}: ${reason}`);
    this.name = "SnapshotValidationError";
  }
}

/** Merge page records into one set of collections; the first record with an id wins. */
export function mergeRecords(pages: readonly Pick<PageExtract, "records">[]): RecordCollections {
  const merged: RecordCollections = {};
  const seen = new Map<string, Set<string>>();
  for (const page of pages) {
    for (const [collection, records] of Object.entries(page.records)) {
      const list = (merged[collection] ??= []);
      let ids = seen.get(collection);
      if (!ids) {
        ids = new Set();
        seen.set(collection, ids);
      }
      for (const record of records) {
        if (!ids.has(record.id)) {
          ids.add(record.id);
          list.push({ ...record });
        }
      }
    }
  }
  return merged;
}

/** Build the organizers' site-content.json from a snapshot. Noindex pages are left out. */
export function toSiteContent(snapshot: AgentSnapshot): SiteContent {
  return {
    source: snapshot.source,
    fetchedAt: snapshot.fetchedAt,
    pages: snapshot.pages.filter((page) => !page.noindex).map((page) => ({ url: page.url, title: page.title, text: page.text })),
    records: copyRecords(snapshot.records),
  };
}

/**
 * The part of a snapshot that a published site keeps: nothing but what its files are generated from. No links,
 * forms, JSON-LD, headers, probe bodies or per-page records, and no page marked noindex (no file shows it).
 */
export function agentSnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  return {
    source: snapshot.source,
    host: snapshot.host,
    fetchedAt: snapshot.fetchedAt,
    pages: snapshot.pages.filter((page) => !page.noindex).map(({ url, title, text, noindex }) => ({ url, title, text, noindex })),
    records: copyRecords(snapshot.records),
  };
}

function copyRecords(records: RecordCollections): RecordCollections {
  const out: RecordCollections = {};
  for (const [collection, list] of Object.entries(records)) {
    out[collection] = list.map((record) => {
      const copy: SiteRecord = { ...record };
      for (const [key, value] of Object.entries(copy)) {
        if (Array.isArray(value)) copy[key] = [...value];
      }
      return copy;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runtime validation. The result is a fresh object with only the known fields.

type Obj = Record<string, unknown>;

function fail(path: string, reason: string): never {
  throw new SnapshotValidationError(path, reason);
}

function obj(value: unknown, path: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected an object");
  return value as Obj;
}

function arr(value: unknown, path: string, max?: number): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  if (max !== undefined && value.length > max) fail(path, `more than ${max} items`);
  return value;
}

function str(value: unknown, path: string, max?: number): string {
  if (typeof value !== "string") fail(path, "expected a string");
  if (max !== undefined && value.length > max) fail(path, `longer than ${max} characters`);
  return value;
}

function strOrNull(value: unknown, path: string, max?: number): string | null {
  return value === null ? null : str(value, path, max);
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}

function int(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) fail(path, "expected a non-negative integer");
  return value;
}

function httpUrl(value: unknown, path: string): string {
  const text = str(value, path, 4096);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    fail(path, "expected an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") fail(path, "expected an http or https URL");
  return text;
}

function linkUrl(value: unknown, path: string): string {
  const text = str(value, path, 4096);
  if (/^(mailto|tel):/i.test(text)) return text;
  return httpUrl(text, path);
}

function isoDate(value: unknown, path: string): string {
  const text = str(value, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(text) || Number.isNaN(Date.parse(text))) {
    fail(path, "expected an ISO 8601 timestamp");
  }
  return text;
}

function json(value: unknown, path: string, depth: number): JsonValue {
  if (depth > MAX_JSON_DEPTH) fail(path, "nested too deeply");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "expected a finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item, i) => json(item, `${path}[${i}]`, depth + 1));
  const out: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(obj(value, path))) out[key] = json(item, `${path}.${key}`, depth + 1);
  return out;
}

function headers(value: unknown, path: string): KeptHeaders {
  const input = obj(value, path);
  const out: KeptHeaders = {};
  for (const name of KEPT_HEADERS) {
    if (input[name] !== undefined) out[name] = str(input[name], `${path}.${name}`, 4096);
  }
  return out;
}

function record(value: unknown, path: string): SiteRecord {
  const input = obj(value, path);
  const out: SiteRecord = {
    id: str(input.id, `${path}.id`, MAX_RECORD_ID_CHARS),
    type: str(input.type, `${path}.type`, 200),
    url: httpUrl(input.url, `${path}.url`),
  };
  if (out.id.length === 0) fail(`${path}.id`, "expected a non-empty string");
  for (const [key, field] of Object.entries(input)) {
    if (key === "id" || key === "type" || key === "url" || field === undefined) continue;
    out[key] = Array.isArray(field) ? field.map((item, i) => str(item, `${path}.${key}[${i}]`)) : str(field, `${path}.${key}`);
  }
  return out;
}

function records(value: unknown, path: string): RecordCollections {
  const out: RecordCollections = {};
  for (const [collection, list] of Object.entries(obj(value, path))) {
    out[collection] = arr(list, `${path}.${collection}`).map((item, i) => record(item, `${path}.${collection}[${i}]`));
  }
  return out;
}

function form(value: unknown, path: string): FormExtract {
  const input = obj(value, path);
  return {
    method: str(input.method, `${path}.method`, 32),
    action: httpUrl(input.action, `${path}.action`),
    inputs: arr(input.inputs, `${path}.inputs`, MAX_FORM_INPUTS).map((item, i) => {
      const field = obj(item, `${path}.inputs[${i}]`);
      const at = `${path}.inputs[${i}]`;
      return {
        name: strOrNull(field.name, `${at}.name`, 1024),
        type: str(field.type, `${at}.type`, 64),
        label: strOrNull(field.label, `${at}.label`, 2048),
        hidden: bool(field.hidden, `${at}.hidden`),
      };
    }),
  };
}

function page(value: unknown, path: string): SnapshotPage {
  const input = obj(value, path);
  return {
    url: httpUrl(input.url, `${path}.url`),
    status: int(input.status, `${path}.status`),
    truncated: bool(input.truncated, `${path}.truncated`),
    title: str(input.title, `${path}.title`, 4096),
    description: strOrNull(input.description, `${path}.description`, 8192),
    lang: strOrNull(input.lang, `${path}.lang`, 64),
    text: str(input.text, `${path}.text`, MAX_TEXT_CHARS),
    textTruncated: bool(input.textTruncated, `${path}.textTruncated`),
    noindex: bool(input.noindex, `${path}.noindex`),
    headers: headers(input.headers, `${path}.headers`),
    jsonLd: arr(input.jsonLd, `${path}.jsonLd`, MAX_JSON_LD_ITEMS).map((item, i) => json(item, `${path}.jsonLd[${i}]`, 0)),
    jsonLdInvalid: int(input.jsonLdInvalid, `${path}.jsonLdInvalid`),
    forms: arr(input.forms, `${path}.forms`, MAX_FORMS).map((item, i) => form(item, `${path}.forms[${i}]`)),
    links: arr(input.links, `${path}.links`, MAX_LINKS).map((item, i) => {
      const link = obj(item, `${path}.links[${i}]`);
      return {
        href: linkUrl(link.href, `${path}.links[${i}].href`),
        text: str(link.text, `${path}.links[${i}].text`, 2048),
        sameHost: bool(link.sameHost, `${path}.links[${i}].sameHost`),
      };
    }),
    records: records(input.records, `${path}.records`),
  };
}

function probe(value: unknown, path: string): Probe {
  const input = obj(value, path);
  return {
    url: httpUrl(input.url, `${path}.url`),
    status: input.status === null ? null : int(input.status, `${path}.status`),
    contentType: strOrNull(input.contentType, `${path}.contentType`, 1024),
    body: strOrNull(input.body, `${path}.body`, PROBE_BODY_MAX_CHARS),
    accessControlAllowOrigin: strOrNull(input.accessControlAllowOrigin, `${path}.accessControlAllowOrigin`, 4096),
  };
}

/** Check that `value` has the Snapshot shape and return a copy with only the known fields. */
export function validateSnapshot(value: unknown): Snapshot {
  const input = obj(value, "$");
  if (input.version !== SNAPSHOT_VERSION) fail("$.version", `expected "${SNAPSHOT_VERSION}"`);
  const probes = obj(input.probes, "$.probes");
  return {
    version: SNAPSHOT_VERSION,
    source: httpUrl(input.source, "$.source"),
    inputUrl: httpUrl(input.inputUrl, "$.inputUrl"),
    finalUrl: httpUrl(input.finalUrl, "$.finalUrl"),
    host: str(input.host, "$.host", 253),
    fetchedAt: isoDate(input.fetchedAt, "$.fetchedAt"),
    pages: arr(input.pages, "$.pages").map((item, i) => page(item, `$.pages[${i}]`)),
    probes: {
      agentManifest: probe(probes.agentManifest, "$.probes.agentManifest"),
      llmsTxt: probe(probes.llmsTxt, "$.probes.llmsTxt"),
      sitemap: probe(probes.sitemap, "$.probes.sitemap"),
      robots: probe(probes.robots, "$.probes.robots"),
      ...(probes.network === undefined ? {} : { network: probe(probes.network, "$.probes.network") }),
    },
    skipped: arr(input.skipped, "$.skipped").map((item, i) => {
      const entry = obj(item, `$.skipped[${i}]`);
      return { url: httpUrl(entry.url, `$.skipped[${i}].url`), reason: str(entry.reason, `$.skipped[${i}].reason`, 200) };
    }),
    records: records(input.records, "$.records"),
    excludedNoindex: arr(input.excludedNoindex, "$.excludedNoindex").map((item, i) => httpUrl(item, `$.excludedNoindex[${i}]`)),
  };
}
