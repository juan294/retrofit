// The 16 checks of score/v1 (phase-3.md "Score version", docs/research/score-tool-contract.md).
// Each check is a pure function of the Snapshot. Evidence is Retrofit's own wording from
// fixed templates: URLs (clipped), HTTP statuses, counts, lengths, a well-formed lang
// value and schema.org type names from fixed lists. It never quotes page prose.

import robotsParser from "robots-parser";
import { PROBE_BODY_MAX_CHARS, type JsonValue, type Probe, type Snapshot, type SnapshotPage } from "@/lib/snapshot/types";
import { declaredNetworkUrl, readManifest } from "./manifest";
import { validateNetworkText } from "./network";

export type CheckOutcome = "pass" | "fail" | "not-checked";

export const CHECK_DEFINITIONS = [
  { id: "aw.manifest", group: "Agentic web", weight: 15, rule: "/agent-manifest.json returns JSON with a network that has name, front_man and hocon" },
  { id: "aw.network-valid", group: "Agentic web", weight: 10, rule: "The declared network loads and passes validateNetwork" },
  { id: "aw.cors", group: "Agentic web", weight: 5, rule: "The manifest response permits other origins" },
  { id: "disc.robots-agents", group: "Discoverability", weight: 8, rule: "robots.txt does not disallow / for GPTBot, ClaudeBot, PerplexityBot, Google-Extended or RetrofitBot" },
  { id: "disc.sitemap", group: "Discoverability", weight: 4, rule: "Sitemap declared in robots.txt or /sitemap.xml returns XML" },
  { id: "disc.llms-txt", group: "Discoverability", weight: 4, rule: "/llms.txt returns text" },
  { id: "read.server-text", group: "Readable content", weight: 12, rule: "Home page HTML has at least 200 characters of main text without JavaScript" },
  { id: "read.title-description", group: "Readable content", weight: 4, rule: "Title and meta description on the home page" },
  { id: "read.lang", group: "Readable content", weight: 2, rule: "<html lang> present" },
  { id: "data.jsonld", group: "Structured data", weight: 8, rule: "At least one valid JSON-LD block" },
  { id: "data.business", group: "Structured data", weight: 6, rule: "Organization or LocalBusiness subtype with a name and an address or URL" },
  { id: "data.offers", group: "Structured data", weight: 6, rule: "Product, Offer, MenuItem, Event or Service present" },
  { id: "data.hours", group: "Structured data", weight: 3, rule: "OpeningHoursSpecification present (not checked without LocalBusiness)" },
  { id: "act.form-labels", group: "Actionability", weight: 5, rule: "Every visible input in fetched forms has a label or aria-label" },
  { id: "act.task-links", group: "Actionability", weight: 4, rule: "Home page links to a task page (contact, book, order, reserve, buy, menu)" },
  { id: "sec.https", group: "Security", weight: 4, rule: "Final URL uses HTTPS" },
] as const;

export type CheckId = (typeof CHECK_DEFINITIONS)[number]["id"];

export interface CheckResult {
  id: CheckId;
  group: string;
  weight: number;
  result: CheckOutcome;
  rule: string;
  evidence: string;
}

export const MAX_EVIDENCE_CHARS = 300;
const MAX_URL_CHARS = 200;
const MIN_MAIN_TEXT = 200;

/** Agents whose access to `/` disc.robots-agents checks. */
export const AI_AGENTS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "RetrofitBot"] as const;

// schema.org LocalBusiness and its subtypes (schema.org 29, the common branches).
export const LOCAL_BUSINESS_TYPES: ReadonlySet<string> = new Set(
  (
    "LocalBusiness AnimalShelter ArchiveOrganization AutomotiveBusiness AutoBodyShop AutoDealer AutoPartsStore AutoRental AutoRepair AutoWash GasStation MotorcycleDealer MotorcycleRepair " +
    "ChildCare Dentist DryCleaningOrLaundry EmergencyService FireStation Hospital PoliceStation EmploymentAgency " +
    "EntertainmentBusiness AdultEntertainment AmusementPark ArtGallery Casino ComedyClub MovieTheater NightClub " +
    "FinancialService AccountingService AutomatedTeller BankOrCreditUnion InsuranceAgency " +
    "FoodEstablishment Bakery BarOrPub Brewery CafeOrCoffeeShop Distillery FastFoodRestaurant IceCreamShop Restaurant Winery " +
    "GovernmentOffice PostOffice HealthAndBeautyBusiness BeautySalon DaySpa HairSalon HealthClub NailSalon TattooParlor " +
    "HomeAndConstructionBusiness Electrician GeneralContractor HVACBusiness HousePainter Locksmith MovingCompany Plumber RoofingContractor " +
    "InternetCafe LegalService Attorney Notary Library " +
    "LodgingBusiness BedAndBreakfast Campground Hostel Hotel Motel Resort SkiResort VacationRental " +
    "MedicalBusiness CommunityHealth Dermatology DietNutrition Emergency Geriatric Gynecologic MedicalClinic CovidTestingFacility Midwifery Nursing Obstetric Oncologic Optician Optometric Otolaryngologic Pediatric Pharmacy Physician Physiotherapy PlasticSurgery Podiatric PrimaryCare Psychiatric PublicHealth " +
    "ProfessionalService RadioStation RealEstateAgent RecyclingCenter SelfStorage ShoppingCenter " +
    "SportsActivityLocation BowlingAlley ExerciseGym GolfCourse PublicSwimmingPool SportsClub StadiumOrArena TennisComplex " +
    "Store BikeStore BookStore ClothingStore ComputerStore ConvenienceStore DepartmentStore ElectronicsStore Florist FurnitureStore GardenStore GroceryStore HardwareStore HobbyShop HomeGoodsStore JewelryStore LiquorStore MensClothingStore MobilePhoneStore MovieRentalStore MusicStore OfficeEquipmentStore OutletStore PawnShop PetStore ShoeStore SportingGoodsStore TireShop ToyStore WholesaleStore " +
    "TelevisionStation TouristInformationCenter TravelAgency"
  ).split(" "),
);

// schema.org Organization and its subtypes outside LocalBusiness.
export const ORGANIZATION_TYPES: ReadonlySet<string> = new Set([
  ...LOCAL_BUSINESS_TYPES,
  ...(
    "Organization Airline Consortium Cooperative Corporation EducationalOrganization CollegeOrUniversity ElementarySchool HighSchool MiddleSchool Preschool School " +
    "FundingScheme GovernmentOrganization LibrarySystem MedicalOrganization DiagnosticLab VeterinaryCare NGO NewsMediaOrganization OnlineBusiness OnlineStore " +
    "PerformingGroup DanceGroup MusicGroup TheaterGroup PoliticalParty Project FundingAgency ResearchProject ResearchOrganization SearchRescueOrganization " +
    "SportsOrganization SportsTeam WorkersUnion"
  ).split(" "),
]);

const OFFER_TYPES = ["Product", "Offer", "MenuItem", "Event", "Service"] as const;
const EXCLUDED_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);
const TASK_WORDS = new Set(["contact", "book", "booking", "bookings", "order", "orders", "ordering", "reserve", "reservation", "reservations", "buy", "menu", "menus"]);

// ---------------------------------------------------------------------------
// Helpers

const DEFINITIONS = new Map(CHECK_DEFINITIONS.map((d) => [d.id, d]));

function result(id: CheckId, outcome: CheckOutcome, evidence: string): CheckResult {
  const d = DEFINITIONS.get(id)!;
  return { id, group: d.group, weight: d.weight, result: outcome, rule: d.rule, evidence: clip(evidence, MAX_EVIDENCE_CHARS) };
}

/** `text` cut to at most `max` characters, the last one an ellipsis when cut. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const clipUrl = (url: string) => clip(url, MAX_URL_CHARS);

const okStatus = (status: number | null): status is number => status !== null && status >= 200 && status < 300;
const mime = (p: Probe) => (p.contentType ?? "").split(";")[0]!.trim().toLowerCase();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const list = (items: readonly string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

function homePage(s: Snapshot): SnapshotPage | undefined {
  return s.pages.find((p) => p.url === s.finalUrl);
}

function schemaName(value: string): string {
  return value.replace(/^(?:https?:\/\/schema\.org\/|schema:)/i, "");
}

type JsonObject = { [key: string]: JsonValue };
const isObject = (v: JsonValue | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every JSON-LD object on every page, nested ones included, with its schema.org types. */
function jsonLdNodes(s: Snapshot): { node: JsonObject; types: string[] }[] {
  const out: { node: JsonObject; types: string[] }[] = [];
  const visit = (v: JsonValue): void => {
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (!isObject(v)) return;
    const raw = v["@type"];
    const types = (Array.isArray(raw) ? raw : [raw]).filter((t): t is string => typeof t === "string").map(schemaName);
    out.push({ node: v, types });
    for (const [key, child] of Object.entries(v)) if (key !== "@type") visit(child);
  };
  for (const page of s.pages) for (const item of page.jsonLd) visit(item);
  return out;
}

const filled = (v: JsonValue | undefined) => (typeof v === "string" ? v.trim() !== "" : isObject(v) || (Array.isArray(v) && v.length > 0));

function robotsRules(s: Snapshot) {
  const p = s.probes.robots;
  return robotsParser(new URL("/robots.txt", s.finalUrl).href, p.body ?? "");
}

// ---------------------------------------------------------------------------
// Agentic web

export function checkManifest(s: Snapshot): CheckResult {
  const p = s.probes.agentManifest;
  const url = clipUrl(p.url);
  const m = readManifest(p);
  switch (m.kind) {
    case "not-read":
      return result("aw.manifest", "not-checked", `${url} was not read.`);
    case "status":
      return result("aw.manifest", "fail", `${url} returned HTTP ${m.status}.`);
    case "not-json":
      return result("aw.manifest", "fail", `${url} did not return a JSON object.`);
    case "no-network":
      return result("aw.manifest", "fail", `${url} lists no network.`);
    case "incomplete":
      return result("aw.manifest", "fail", `The first network in ${url} has no ${list(m.missing)}.`);
    case "ok":
      return result("aw.manifest", "pass", `${url} declares a network with name, front_man and hocon.`);
  }
}

export function checkNetworkValid(s: Snapshot): CheckResult {
  const manifest = s.probes.agentManifest;
  const m = readManifest(manifest);
  if (m.kind === "not-read") return result("aw.network-valid", "not-checked", "The manifest was not read, so no network was loaded.");
  if (m.kind !== "ok") return result("aw.network-valid", "fail", "No manifest, so no network was loaded.");
  if (!declaredNetworkUrl(manifest)) return result("aw.network-valid", "fail", "The manifest's hocon is not an http or https address.");
  const n = s.probes.network;
  if (!n) return result("aw.network-valid", "not-checked", "The declared network was not read.");
  const url = clipUrl(n.url);
  if (n.status === null) return result("aw.network-valid", "fail", `${url} could not be loaded.`);
  if (!okStatus(n.status)) return result("aw.network-valid", "fail", `${url} returned HTTP ${n.status}.`);
  if (n.body === null || n.body.trim() === "") return result("aw.network-valid", "fail", `${url} returned no readable text.`);
  const v = validateNetworkText(n.body, m.network.name);
  if (v.kind === "unparsable") {
    const cut = n.body.length >= PROBE_BODY_MAX_CHARS ? ` Retrofit reads at most ${PROBE_BODY_MAX_CHARS} characters of it.` : "";
    return result("aw.network-valid", "fail", `${url} could not be parsed as HOCON or JSON.${cut}`);
  }
  if (v.kind === "invalid") return result("aw.network-valid", "fail", `${url} failed validateNetwork with ${plural(v.errors, "error", "errors")}.`);
  return result("aw.network-valid", "pass", `${url} passed validateNetwork.`);
}

export function checkCors(s: Snapshot): CheckResult {
  const p = s.probes.agentManifest;
  if (p.status === null) return result("aw.cors", "not-checked", "The manifest was not read.");
  if (!okStatus(p.status)) return result("aw.cors", "fail", "No manifest response.");
  const acao = (p.accessControlAllowOrigin ?? "").trim();
  if (acao === "*") return result("aw.cors", "pass", "The manifest response has Access-Control-Allow-Origin: *.");
  if (!acao) return result("aw.cors", "fail", "The manifest response has no Access-Control-Allow-Origin header.");
  let origin: string | null = null;
  try {
    const u = new URL(acao);
    origin = u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    origin = null;
  }
  if (origin === null) return result("aw.cors", "fail", "The manifest response's Access-Control-Allow-Origin is not an origin.");
  if (origin === new URL(s.finalUrl).origin) return result("aw.cors", "fail", "The manifest response allows only the site's own origin.");
  return result("aw.cors", "pass", "The manifest response allows another origin.");
}

// ---------------------------------------------------------------------------
// Discoverability

export function checkRobotsAgents(s: Snapshot): CheckResult {
  const p = s.probes.robots;
  if (p.status === null) return result("disc.robots-agents", "not-checked", "robots.txt was not read.");
  if (p.status >= 500) return result("disc.robots-agents", "fail", `robots.txt returned HTTP ${p.status}, which crawlers treat as disallow all.`);
  if (!okStatus(p.status)) return result("disc.robots-agents", "pass", `robots.txt returned HTTP ${p.status}, so nothing is disallowed.`);
  const rules = robotsRules(s);
  const home = new URL("/", s.finalUrl).href;
  const blocked = AI_AGENTS.filter((agent) => rules.isDisallowed(home, agent) === true);
  if (blocked.length) return result("disc.robots-agents", "fail", `robots.txt disallows / for ${list(blocked)}.`);
  return result("disc.robots-agents", "pass", `None of the ${AI_AGENTS.length} agents is disallowed from /.`);
}

export function checkSitemap(s: Snapshot): CheckResult {
  const robots = s.probes.robots;
  const sitemap = s.probes.sitemap;
  const declared = okStatus(robots.status) && robots.body ? robotsRules(s).getSitemaps().length : 0;
  if (declared > 0) return result("disc.sitemap", "pass", `robots.txt declares ${plural(declared, "sitemap", "sitemaps")}.`);
  const url = clipUrl(sitemap.url);
  const body = (sitemap.body ?? "").trimStart();
  const xml = /(^|[/+])xml$/.test(mime(sitemap)) || /^(<\?xml|<urlset|<sitemapindex)/i.test(body);
  if (okStatus(sitemap.status) && body && xml) return result("disc.sitemap", "pass", `${url} returned XML.`);
  if (robots.status === null || sitemap.status === null) return result("disc.sitemap", "not-checked", "robots.txt or /sitemap.xml was not read.");
  const found = okStatus(sitemap.status) ? `returned ${mime(sitemap) || "no content type"}, not XML` : `returned HTTP ${sitemap.status}`;
  return result("disc.sitemap", "fail", `robots.txt declares no sitemap and ${url} ${found}.`);
}

export function checkLlmsTxt(s: Snapshot): CheckResult {
  const p = s.probes.llmsTxt;
  const url = clipUrl(p.url);
  if (p.status === null) return result("disc.llms-txt", "not-checked", `${url} was not read.`);
  if (!okStatus(p.status)) return result("disc.llms-txt", "fail", `${url} returned HTTP ${p.status}.`);
  const type = mime(p);
  if (!type.startsWith("text/") || type === "text/html") return result("disc.llms-txt", "fail", `${url} returned ${type || "no content type"}, not text.`);
  const length = (p.body ?? "").trim().length;
  if (length === 0) return result("disc.llms-txt", "fail", `${url} is empty.`);
  return result("disc.llms-txt", "pass", `${url} returned ${plural(length, "character", "characters")} of text.`);
}

// ---------------------------------------------------------------------------
// Readable content

const NO_HOME = "The home page was not read as HTML.";

export function checkServerText(s: Snapshot): CheckResult {
  const home = homePage(s);
  if (!home) return result("read.server-text", "not-checked", NO_HOME);
  if (home.noindex) return result("read.server-text", "not-checked", "The home page asks not to be indexed, so its text was not kept.");
  const n = home.text.length;
  if (n >= MIN_MAIN_TEXT) return result("read.server-text", "pass", `${n} characters of main text.`);
  return result("read.server-text", "fail", `Only ${plural(n, "character", "characters")} of main text without JavaScript.`);
}

export function checkTitleDescription(s: Snapshot): CheckResult {
  const home = homePage(s);
  if (!home) return result("read.title-description", "not-checked", NO_HOME);
  const title = home.title.length;
  const description = home.description?.length ?? 0;
  const parts = [title ? `Title ${title} characters` : "No title", description ? `description ${description} characters` : "no meta description"];
  return result("read.title-description", title && description ? "pass" : "fail", `${parts.join(", ")}.`);
}

export function checkLang(s: Snapshot): CheckResult {
  const home = homePage(s);
  if (!home) return result("read.lang", "not-checked", NO_HOME);
  const lang = home.lang?.trim() ?? "";
  if (!lang) return result("read.lang", "fail", "The html element has no lang attribute.");
  if (/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8}){0,4}$/.test(lang)) return result("read.lang", "pass", `lang="${lang}".`);
  return result("read.lang", "pass", "lang is present but is not a well-formed language tag.");
}

// ---------------------------------------------------------------------------
// Structured data

const NO_PAGES = "No HTML page was read.";

export function checkJsonLd(s: Snapshot): CheckResult {
  if (s.pages.length === 0) return result("data.jsonld", "not-checked", NO_PAGES);
  const withLd = s.pages.filter((p) => p.jsonLd.length > 0);
  const items = withLd.reduce((n, p) => n + p.jsonLd.length, 0);
  const invalid = s.pages.reduce((n, p) => n + p.jsonLdInvalid, 0);
  const bad = invalid ? ` ${plural(invalid, "block", "blocks")} could not be parsed.` : "";
  if (items) return result("data.jsonld", "pass", `${plural(items, "valid JSON-LD item", "valid JSON-LD items")} on ${plural(withLd.length, "page", "pages")}.${bad}`);
  return result("data.jsonld", "fail", `No valid JSON-LD on ${plural(s.pages.length, "page", "pages")}.${bad}`);
}

export function checkBusiness(s: Snapshot): CheckResult {
  if (s.pages.length === 0) return result("data.business", "not-checked", NO_PAGES);
  const orgs = jsonLdNodes(s).filter((n) => n.types.some((t) => ORGANIZATION_TYPES.has(t)));
  for (const { node, types } of orgs) {
    if (!filled(node.name)) continue;
    const has = [filled(node.address) && "address", filled(node.url) && "url"].filter((x): x is string => Boolean(x));
    if (has.length) {
      const type = types.find((t) => ORGANIZATION_TYPES.has(t))!;
      return result("data.business", "pass", `${type} with name and ${list(has)}.`);
    }
  }
  if (orgs.length) return result("data.business", "fail", "Organization or LocalBusiness found, but none has a name and an address or URL.");
  return result("data.business", "fail", `No Organization or LocalBusiness on ${plural(s.pages.length, "page", "pages")}.`);
}

export function checkOffers(s: Snapshot): CheckResult {
  if (s.pages.length === 0) return result("data.offers", "not-checked", NO_PAGES);
  const found = new Set<string>();
  for (const { types } of jsonLdNodes(s)) {
    for (const t of types) {
      if ((OFFER_TYPES as readonly string[]).includes(t)) found.add(t);
      else if (/^[A-Za-z]{1,60}Event$/.test(t)) found.add("Event");
    }
  }
  const names = OFFER_TYPES.filter((t) => found.has(t));
  if (names.length) return result("data.offers", "pass", `Found ${list(names)}.`);
  return result("data.offers", "fail", `None of these types found on ${plural(s.pages.length, "page", "pages")}.`);
}

export function checkHours(s: Snapshot): CheckResult {
  const nodes = jsonLdNodes(s);
  if (!nodes.some((n) => n.types.some((t) => LOCAL_BUSINESS_TYPES.has(t)))) return result("data.hours", "not-checked", "No LocalBusiness found.");
  const hours = nodes.filter((n) => n.types.includes("OpeningHoursSpecification")).length;
  if (hours) return result("data.hours", "pass", `${plural(hours, "OpeningHoursSpecification entry", "OpeningHoursSpecification entries")}.`);
  return result("data.hours", "fail", "LocalBusiness found with no OpeningHoursSpecification.");
}

// ---------------------------------------------------------------------------
// Actionability

export function checkFormLabels(s: Snapshot): CheckResult {
  let forms = 0;
  let visible = 0;
  let unlabelled = 0;
  let firstBad: string | null = null;
  for (const page of s.pages) {
    for (const form of page.forms) {
      forms += 1;
      for (const field of form.inputs) {
        if (field.hidden || EXCLUDED_INPUT_TYPES.has(field.type)) continue;
        visible += 1;
        if (!field.label) {
          unlabelled += 1;
          firstBad ??= page.url;
        }
      }
    }
  }
  if (forms === 0) return result("act.form-labels", "not-checked", `No forms on ${plural(s.pages.length, "fetched page", "fetched pages")}.`);
  if (visible === 0) return result("act.form-labels", "not-checked", `${plural(forms, "form has", "forms have")} no visible inputs.`);
  if (unlabelled) return result("act.form-labels", "fail", `${unlabelled} of ${visible} visible inputs have no label, on ${clipUrl(firstBad!)}.`);
  const all = visible === 1 ? "The only visible input" : `All ${visible} visible inputs`;
  return result("act.form-labels", "pass", `${all} in ${plural(forms, "form", "forms")} ${visible === 1 ? "has" : "have"} a label or aria-label.`);
}

const words = (text: string) => text.toLowerCase().split(/[^a-z]+/).filter(Boolean);

export function checkTaskLinks(s: Snapshot): CheckResult {
  const home = homePage(s);
  if (!home) return result("act.task-links", "not-checked", NO_HOME);
  const hits: string[] = [];
  for (const link of home.links) {
    let path = "";
    let shown = "a contact address";
    if (/^https?:/i.test(link.href)) {
      const u = new URL(link.href);
      path = decodeURIComponentSafe(u.pathname);
      shown = link.sameHost ? clipUrl(u.pathname) : `a page on ${clipUrl(u.host)}`;
    }
    if ([...words(link.text), ...words(path)].some((w) => TASK_WORDS.has(w)) && !hits.includes(shown)) hits.push(shown);
  }
  if (hits.length) {
    const shown = hits.slice(0, 3);
    const more = hits.length > 3 ? ` and ${hits.length - 3} more` : "";
    return result("act.task-links", "pass", `Links to ${list(shown)}${more}.`);
  }
  return result("act.task-links", "fail", `None of ${plural(home.links.length, "home page link", "home page links")} leads to a contact, booking, order, reservation, purchase or menu page.`);
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// Security

export function checkHttps(s: Snapshot): CheckResult {
  const https = new URL(s.finalUrl).protocol === "https:";
  return result("sec.https", https ? "pass" : "fail", `The final URL ${clipUrl(s.finalUrl)} uses ${https ? "HTTPS" : "HTTP"}.`);
}

/** One check function per score/v1 id. */
export const CHECKS: Record<CheckId, (s: Snapshot) => CheckResult> = {
  "aw.manifest": checkManifest,
  "aw.network-valid": checkNetworkValid,
  "aw.cors": checkCors,
  "disc.robots-agents": checkRobotsAgents,
  "disc.sitemap": checkSitemap,
  "disc.llms-txt": checkLlmsTxt,
  "read.server-text": checkServerText,
  "read.title-description": checkTitleDescription,
  "read.lang": checkLang,
  "data.jsonld": checkJsonLd,
  "data.business": checkBusiness,
  "data.offers": checkOffers,
  "data.hours": checkHours,
  "act.form-labels": checkFormLabels,
  "act.task-links": checkTaskLinks,
  "sec.https": checkHttps,
};
