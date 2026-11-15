// Turns one fetched HTML page into plain-text data for the Snapshot. Fetched content is
// untrusted: everything here is data for the UI and tools, never markup or instructions.

import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import {
  KEPT_HEADERS,
  MAX_FORMS,
  MAX_FORM_INPUTS,
  MAX_JSON_DEPTH,
  MAX_JSON_LD_ITEMS,
  MAX_LINKS,
  MAX_RECORD_ID_CHARS,
  MAX_TEXT_CHARS,
  type FormExtract,
  type FormInput,
  type JsonValue,
  type KeptHeaders,
  type LinkExtract,
  type PageExtract,
  type RecordCollections,
  type SiteRecord,
} from "@/lib/snapshot/types";

export { MAX_TEXT_CHARS };

export const EMAIL_PLACEHOLDER = "[email removed]";

export interface ExtractInput {
  url: string;
  html: string;
  headers: Record<string, string>;
}

// Structural view of the domhandler nodes that cheerio returns.
interface DomNode {
  type: string;
  name?: string;
  data?: string;
  children?: DomNode[];
}

// Bounded repetitions keep matching linear on hostile input (a long run of word characters).
const EMAIL = /[A-Z0-9._%+-]{1,64}(?:@|%40)[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63}){0,8}\.[A-Z]{2,24}/gi;
const NON_CONTENT_TAGS = ["script", "style", "noscript", "template", "textarea"];
const NON_CONTENT = new Set(NON_CONTENT_TAGS);
const NON_CONTENT_OR_CHROME = new Set([...NON_CONTENT_TAGS, "nav", "header", "footer", "aside"]);
const LABEL_SKIP = new Set([...NON_CONTENT_TAGS, "select", "option", "datalist"]);
const BLOCK = new Set(
  "address article aside blockquote br dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul".split(
    " ",
  ),
);

const COLLECTIONS: Record<string, string> = {
  Product: "products",
  Offer: "offers",
  MenuItem: "menu_items",
  Event: "events",
  Service: "services",
  OpeningHoursSpecification: "opening_hours",
};
const LODGING = new Set(["LodgingBusiness", "Hotel", "Motel", "Hostel", "BedAndBreakfast", "Resort", "Campground"]);
const ROOMS = new Set(["HotelRoom", "Room", "Suite"]);

/** Replace every email address with the placeholder. */
export function scrubEmails(text: string): string {
  if (!text.includes("@") && !/%40/i.test(text)) return text;
  return text.replace(EMAIL, EMAIL_PLACEHOLDER);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function cleanText(text: string, max: number): string {
  return clip(scrubEmails(normalize(text)), max);
}

function nodeText(node: DomNode | undefined, skip: ReadonlySet<string>): string {
  const parts: string[] = [];
  const visit = (current: DomNode): void => {
    if (current.type === "text") {
      parts.push(current.data ?? "");
      return;
    }
    if (current.type === "comment" || current.type === "directive") return;
    const name = current.name?.toLowerCase();
    if (name && skip.has(name)) return;
    const block = name !== undefined && BLOCK.has(name);
    if (block) parts.push(" ");
    for (const child of current.children ?? []) visit(child);
    if (block) parts.push(" ");
  };
  if (node) visit(node);
  return parts.join("");
}

/** Convert a possibly-HTML string to plain text without emails. */
function plain(value: string, max = 4096): string {
  const text = /[<&]/.test(value) ? nodeText(load(value, null, false).root().get(0) as unknown as DomNode, NON_CONTENT) : value;
  return cleanText(text, max);
}

function keptHeaders(headers: Record<string, string>): KeptHeaders {
  const out: KeptHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if ((KEPT_HEADERS as readonly string[]).includes(key)) out[key as keyof KeptHeaders] = value;
  }
  return out;
}

const NAMED_DIRECTIVE = new Set(["unavailable_after", "max-snippet", "max-image-preview", "max-video-preview"]);

function headerNoindex(value: string | undefined): boolean {
  if (!value) return false;
  let agent: string | null = null;
  for (const raw of value.split(",")) {
    let token = raw.trim().toLowerCase();
    const scoped = /^([a-z0-9_*-]+)\s*:\s*(.*)$/.exec(token);
    if (scoped && !NAMED_DIRECTIVE.has(scoped[1]!)) {
      agent = scoped[1]!;
      token = scoped[2]!.trim();
    }
    if ((agent === null || agent === "*" || agent === "retrofitbot") && (token === "noindex" || token === "none")) return true;
  }
  return false;
}

function metaNoindex($: CheerioAPI): boolean {
  return $("meta[name]")
    .toArray()
    .some((el) => {
      const name = ($(el).attr("name") ?? "").trim().toLowerCase();
      if (name !== "robots" && name !== "retrofitbot") return false;
      return ($(el).attr("content") ?? "")
        .toLowerCase()
        .split(",")
        .some((d) => d.trim() === "noindex" || d.trim() === "none");
    });
}

function httpUrl(href: string, base: string): URL | null {
  try {
    const parsed = new URL(href.trim(), base);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

/** Remove emails from a URL and return it normalized, or null if it no longer parses. */
const MAX_URL_CHARS = 4096;

function scrubUrl(url: URL): string | null {
  try {
    const href = new URL(scrubEmails(url.href)).href;
    return href.length <= MAX_URL_CHARS ? href : null;
  } catch {
    return null;
  }
}

function extractLinks($: CheerioAPI, base: string, host: string): LinkExtract[] {
  const links: LinkExtract[] = [];
  const seen = new Set<string>();
  for (const el of $("a[href]").toArray()) {
    if (links.length >= MAX_LINKS) break;
    const raw = ($(el).attr("href") ?? "").trim();
    let href: string | null;
    let sameHost = false;
    if (/^mailto:/i.test(raw)) {
      href = `mailto:${EMAIL_PLACEHOLDER}`;
    } else if (/^tel:/i.test(raw)) {
      href = clip(raw, 256);
    } else {
      const parsed = httpUrl(raw, base);
      if (!parsed) continue;
      parsed.hash = "";
      sameHost = parsed.hostname === host;
      href = scrubUrl(parsed);
    }
    if (!href || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, text: cleanText(nodeText($(el).get(0) as unknown as DomNode, NON_CONTENT), 2048), sameHost });
  }
  return links;
}

function extractForms($: CheerioAPI, pageUrl: string, base: string): FormExtract[] {
  const labelText = (el: unknown): string | null => {
    const text = cleanText(nodeText(el as DomNode, LABEL_SKIP), 2048);
    return text || null;
  };
  // The first <label for=id> in document order, built once per page instead of once per input.
  const labels = $("label").toArray();
  const labelFor = new Map<string, (typeof labels)[number]>();
  for (const l of labels) {
    const target = $(l).attr("for");
    if (target !== undefined && !labelFor.has(target)) labelFor.set(target, l);
  }
  return $("form")
    .toArray()
    .slice(0, MAX_FORMS)
    .map((form) => {
      const $form = $(form);
      const method = clip(($form.attr("method") ?? "get").trim().toLowerCase() || "get", 32);
      const actionAttr = ($form.attr("action") ?? "").trim();
      const action = (actionAttr && scrubUrlOrNull(httpUrl(actionAttr, base))) || pageUrl;
      const inputs: FormInput[] = $form
        .find("input, select, textarea")
        .toArray()
        .slice(0, MAX_FORM_INPUTS)
        .map((field) => {
          const $field = $(field);
          const tag = (field as unknown as DomNode).name?.toLowerCase() ?? "input";
          const type = tag === "input" ? clip(($field.attr("type") ?? "text").trim().toLowerCase() || "text", 64) : tag;
          const hidden = type === "hidden";
          const name = $field.attr("name");
          let label: string | null = null;
          if (!hidden) {
            const id = $field.attr("id");
            const forLabel = id ? labelFor.get(id) : undefined;
            const wrapping = $field.closest("label").get(0);
            const aria = $field.attr("aria-label");
            label =
              (forLabel && labelText(forLabel)) || (wrapping && labelText(wrapping)) || (aria ? cleanText(aria, 2048) || null : null);
          }
          return { name: name === undefined ? null : clip(scrubEmails(name), 1024), type, label, hidden };
        });
      return { method, action, inputs };
    });
}

function scrubUrlOrNull(url: URL | null): string | null {
  return url ? scrubUrl(url) : null;
}

// ---------------------------------------------------------------------------
// JSON-LD

function sanitizeJson(value: unknown, depth: number): JsonValue {
  if (depth > MAX_JSON_DEPTH) return null;
  // A container at the depth limit becomes null, so no value lies deeper than the validator allows.
  if (depth >= MAX_JSON_DEPTH - 1 && typeof value === "object" && value !== null) return null;
  if (typeof value === "string") return scrubEmails(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, depth + 1));
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeJson(item, depth + 1);
    return out;
  }
  return null;
}

function parseJsonLd(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const unwrapped = raw
      .replace(/^\s*(?:\/\/\s*)?(?:<!\[CDATA\[|<!--)/, "")
      .replace(/(?:\/\/\s*)?(?:\]\]>|-->)\s*$/, "")
      .trim();
    if (unwrapped === raw.trim()) throw new Error("invalid JSON-LD");
    return JSON.parse(unwrapped);
  }
}

function isObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractJsonLd($: CheerioAPI): { items: JsonValue[]; invalid: number } {
  const items: JsonValue[] = [];
  let invalid = 0;
  const push = (value: unknown): void => {
    if (isObject(value) && items.length < MAX_JSON_LD_ITEMS) items.push(value);
  };
  for (const el of $("script[type]").toArray()) {
    const type = ($(el).attr("type") ?? "").trim().toLowerCase();
    if (!/^application\/ld\+json\s*(;|$)/.test(type)) continue;
    let parsed: unknown;
    try {
      parsed = sanitizeJson(parseJsonLd($(el).text()), 0);
    } catch {
      invalid += 1;
      continue;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (isObject(item) && Array.isArray(item["@graph"])) {
        for (const node of item["@graph"]) push(node);
      } else {
        push(item);
      }
    }
  }
  return { items, invalid };
}

// ---------------------------------------------------------------------------
// Records

function schemaName(value: string): string {
  return value.replace(/^(?:https?:\/\/schema\.org\/|schema:)/i, "");
}

function typesOf(node: { [key: string]: JsonValue }): string[] {
  const raw = node["@type"];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((t): t is string => typeof t === "string").map(schemaName);
}

function collectionOf(types: string[]): [string, string] | null {
  for (const type of types) {
    const collection = COLLECTIONS[type];
    if (collection) return [type, collection];
  }
  const event = types.find((t) => t.endsWith("Event"));
  return event ? [event, "events"] : null;
}

function scalar(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") return plain(value) || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (isObject(value) && typeof value.name === "string") return plain(value.name) || undefined;
  return undefined;
}

function enumValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? scalar(schemaName(value)) : undefined;
}

function list(value: JsonValue | undefined): string[] | undefined {
  const items = (Array.isArray(value) ? value : [value])
    .map((item) => (typeof item === "string" ? scalar(schemaName(item)) : scalar(item)))
    .filter((item): item is string => item !== undefined);
  return items.length ? items : undefined;
}

function place(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") return scalar(value);
  const first = Array.isArray(value) ? value[0] : value;
  if (!isObject(first)) return undefined;
  if (typeof first.name === "string") return scalar(first.name);
  const address = first.address ?? first;
  if (typeof address === "string") return scalar(address);
  if (!isObject(address)) return undefined;
  const parts = ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"]
    .map((key) => scalar(address[key]))
    .filter((part): part is string => part !== undefined);
  return parts.length ? parts.join(", ") : undefined;
}

type Fields = Record<string, string | string[] | undefined>;

function priceFields(offer: JsonValue | undefined): Fields {
  const first = Array.isArray(offer) ? offer[0] : offer;
  if (!isObject(first)) return {};
  const spec = isObject(first.priceSpecification) ? first.priceSpecification : undefined;
  return {
    price: scalar(first.price) ?? scalar(first.lowPrice) ?? scalar(spec?.price),
    priceCurrency: scalar(first.priceCurrency) ?? scalar(spec?.priceCurrency),
    availability: enumValue(first.availability),
  };
}

function recordFields(type: string, node: { [key: string]: JsonValue }): Fields {
  const base: Fields = { name: scalar(node.name), description: scalar(node.description) };
  if (type === "OpeningHoursSpecification") {
    return {
      dayOfWeek: list(node.dayOfWeek),
      opens: scalar(node.opens),
      closes: scalar(node.closes),
      validFrom: scalar(node.validFrom),
      validThrough: scalar(node.validThrough),
    };
  }
  if (type === "Offer") {
    return { ...base, name: base.name ?? scalar(node.itemOffered), ...priceFields(node) };
  }
  const fields: Fields = { ...base, ...priceFields(node.offers) };
  if (type === "Product") Object.assign(fields, { sku: scalar(node.sku), brand: scalar(node.brand) });
  if (type === "MenuItem") fields.suitableForDiet = list(node.suitableForDiet);
  if (type === "Service") Object.assign(fields, { serviceType: scalar(node.serviceType), areaServed: place(node.areaServed) });
  if (collectionOf([type])?.[1] === "events") {
    Object.assign(fields, {
      startDate: scalar(node.startDate),
      endDate: scalar(node.endDate),
      location: place(node.location),
      eventStatus: enumValue(node.eventStatus),
    });
  }
  return fields;
}

class RecordBuilder {
  readonly records: RecordCollections = {};
  private readonly contents = new Map<string, string>();

  constructor(private readonly url: string) {}

  add(collection: string, type: string, node: { [key: string]: JsonValue }, fields: Fields): void {
    const clean: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) clean[key] = value;
    const content = JSON.stringify([collection, type, clean]);
    const bucket = (this.records[collection] ??= []);
    const rawId = typeof node["@id"] === "string" ? clip(normalize(scrubEmails(node["@id"])), MAX_RECORD_ID_CHARS + 1) : "";
    let id: string;
    if (rawId && rawId.length <= MAX_RECORD_ID_CHARS) {
      id = rawId;
      if (this.contents.has(`${collection}\n${id}`)) return;
    } else {
      const name = typeof clean.name === "string" ? clean.name : "";
      const hash = createHash("sha256")
        .update(JSON.stringify([type, name, this.url, name ? "" : content]))
        .digest("hex")
        .slice(0, 16);
      id = `${type.toLowerCase().slice(0, 100)}-${hash}`;
      for (let n = 2; this.contents.has(`${collection}\n${id}`); n += 1) {
        if (this.contents.get(`${collection}\n${id}`) === content) return;
        id = `${type.toLowerCase().slice(0, 100)}-${hash}-${n}`;
      }
    }
    this.contents.set(`${collection}\n${id}`, content);
    bucket.push({ id, type: type.slice(0, 200), url: this.url, ...clean } as SiteRecord);
  }
}

function collectRecords(items: JsonValue[], url: string): RecordCollections {
  const builder = new RecordBuilder(url);
  const visit = (value: JsonValue, parentKey: string | null, parentTypes: string[], parentIsRecord: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parentKey, parentTypes, parentIsRecord);
      return;
    }
    if (!isObject(value)) return;
    const types = typesOf(value);
    const lodgingParent = parentTypes.some((t) => LODGING.has(t));
    const room = types.find((t) => ROOMS.has(t));

    if (types.includes("Offer") && parentKey === "offers" && parentIsRecord) return; // folded into the parent's price
    if (types.includes("Offer") && lodgingParent && parentKey === "makesOffer" && isObject(value.itemOffered)) {
      const offered = value.itemOffered;
      const offeredRoom = typesOf(offered).find((t) => ROOMS.has(t));
      if (offeredRoom) {
        builder.add("rooms", offeredRoom, offered, { ...recordFields(offeredRoom, offered), ...priceFields(value) });
        return;
      }
    }

    let isRecord = false;
    if (room && lodgingParent && parentKey === "containsPlace") {
      builder.add("rooms", room, value, recordFields(room, value));
      isRecord = true;
    } else {
      const match = collectionOf(types);
      if (match) {
        builder.add(match[1], match[0], value, recordFields(match[0], value));
        isRecord = true;
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("@")) continue;
      visit(child, key, types, isRecord);
    }
  };
  for (const item of items) visit(item, null, [], false);
  return builder.records;
}

// ---------------------------------------------------------------------------

/** Extract plain-text content, metadata, forms, links and records from one HTML page. */
export function extractPage(input: ExtractInput): PageExtract {
  const $ = load(input.html);
  const pageUrl = input.url;
  const host = new URL(pageUrl).hostname;
  const baseHref = $("base[href]").first().attr("href");
  const base = (baseHref && httpUrl(baseHref, pageUrl)?.href) || pageUrl;
  const headers = keptHeaders(input.headers);
  const noindex = metaNoindex($) || headerNoindex(headers["x-robots-tag"]);

  const titleEl = $("title")
    .filter((_, el) => $(el).closest("svg").length === 0)
    .first();
  const title = cleanText(titleEl.text(), 4096);
  const descriptionMeta = $("meta[name]")
    .filter((_, el) => ($(el).attr("name") ?? "").trim().toLowerCase() === "description")
    .first()
    .attr("content");
  const description = descriptionMeta === undefined ? null : cleanText(descriptionMeta, 8192) || null;
  const lang = normalize($("html").attr("lang") ?? "").slice(0, 64) || null;

  const links = extractLinks($, base, host);
  const forms = extractForms($, pageUrl, base);

  let text = "";
  let textTruncated = false;
  let jsonLd: JsonValue[] = [];
  let jsonLdInvalid = 0;
  let records: RecordCollections = {};
  if (!noindex) {
    const main = $("main").get(0) ?? $("article").get(0);
    const root = (main ?? $("body").get(0)) as unknown as DomNode | undefined;
    const skip = main ? NON_CONTENT : NON_CONTENT_OR_CHROME;
    const full = scrubEmails(normalize(nodeText(root, skip)));
    text = clip(full, MAX_TEXT_CHARS);
    textTruncated = text.length < full.length;
    ({ items: jsonLd, invalid: jsonLdInvalid } = extractJsonLd($));
    records = collectRecords(jsonLd, pageUrl);
  }

  return { url: pageUrl, title, description, lang, text, textTruncated, noindex, headers, jsonLd, jsonLdInvalid, forms, links, records };
}
