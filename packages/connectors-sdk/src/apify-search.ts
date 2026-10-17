/**
 * Apify search plans (ADR-042 addendum): instead of repeating one fixed
 * input, an actor source builds its search URLs every run — first from what
 * buyers are asking for right now, then from a keyword × city list in
 * rotation. A search that keeps finding nothing new drops down the rotation.
 * Deterministic and pure; the database supplies demand terms and history.
 */

export interface ApifySearchPlan {
  /** e.g. https://www.facebook.com/marketplace/{city}/search/?query={query} */
  urlTemplate: string;
  /** Where the URLs go in the actor input (default "startUrls"). */
  inputPath?: string;
  /** Each entry as {"url": ...} (default) or a bare string. */
  urlShape?: "object" | "string";
  cities: string[];
  queries: string[];
  /** Search for what recent buyer demand asks for, first. */
  fromDemand: boolean;
  /** Searches per run (default 5, at most 20). */
  perRun?: number;
  /** The item field holding the search URL that found it (Facebook: "facebookUrl"), to credit yield. */
  searchUrlField?: string;
}

export interface PlannedSearch {
  term: string;
  city: string | null;
  url: string;
  origin: "demand" | "list";
}

/** What a (term, city) search did before: when it last ran and its new items, newest first. */
export interface SearchHistory {
  lastAt: string;
  recentNew: number[];
}

export const DEFAULT_PER_RUN = 5;
export const MAX_PER_RUN = 20;
/** The same search is not repeated within this many hours. */
export const REPEAT_AFTER_HOURS = 24;
/** Searches that found nothing new this many times in a row drop down the rotation… */
export const BARREN_AFTER = 3;
/** …and come back only after this many days. */
export const BARREN_RETRY_DAYS = 7;

const SLUG = /^[a-z0-9-]{2,60}$/;

export function parseSearchPlan(v: unknown): { plan: ApifySearchPlan } | { errors: string[] } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { errors: ["search plan must be an object"] };
  const o = v as Record<string, unknown>;
  const errors: string[] = [];
  const template = typeof o["urlTemplate"] === "string" ? o["urlTemplate"].trim() : "";
  if (!/^https:\/\/[^\s]+$/.test(template) || !template.includes("{query}")) errors.push("urlTemplate must be an https URL containing {query}");
  const strings = (k: string, max: number) => {
    const a = o[k];
    if (a === undefined) return [];
    if (!Array.isArray(a) || a.length > max || a.some((x) => typeof x !== "string" || !x.trim() || x.length > 80)) {
      errors.push(`${k} must be a list of up to ${max} short strings`);
      return [];
    }
    return [...new Set(a.map((x: string) => x.trim()))];
  };
  const cities = strings("cities", 50).map((c) => c.toLowerCase());
  const queries = strings("queries", 200);
  if (template.includes("{city}") && cities.length === 0) errors.push("cities are required when urlTemplate has {city}");
  if (cities.some((c) => !SLUG.test(c))) errors.push("cities must be URL slugs like detroit or newyork");
  const fromDemand = o["fromDemand"] === true;
  if (!fromDemand && queries.length === 0) errors.push("give queries, or set fromDemand");
  const perRun = o["perRun"] === undefined ? DEFAULT_PER_RUN : o["perRun"];
  if (typeof perRun !== "number" || !Number.isInteger(perRun) || perRun < 1 || perRun > MAX_PER_RUN) errors.push(`perRun must be 1–${MAX_PER_RUN}`);
  const urlShape = o["urlShape"] ?? "object";
  if (urlShape !== "object" && urlShape !== "string") errors.push("urlShape must be object or string");
  const inputPath = o["inputPath"] ?? "startUrls";
  if (typeof inputPath !== "string" || !/^[A-Za-z_][\w]{0,60}$/.test(inputPath)) errors.push("inputPath must be a top-level input field name");
  const searchUrlField = o["searchUrlField"];
  if (searchUrlField !== undefined && (typeof searchUrlField !== "string" || !searchUrlField || searchUrlField.length > 100)) errors.push("searchUrlField must be a field name");
  if (errors.length) return { errors };
  return {
    plan: {
      urlTemplate: template,
      inputPath: inputPath as string,
      urlShape: urlShape as "object" | "string",
      cities,
      queries,
      fromDemand,
      perRun: perRun as number,
      ...(searchUrlField ? { searchUrlField: searchUrlField as string } : {}),
    },
  };
}

/** A demand phrase as a Marketplace search term: short, plain, no search operators. */
export function searchTerm(raw: string): string | null {
  const t = raw
    .replace(/\b(site|inurl|intitle):\S+/gi, " ")
    .replace(/["“”()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 60)
    .trim();
  return t.length >= 3 ? t : null;
}

export function searchUrl(plan: ApifySearchPlan, term: string, city: string | null): string {
  return plan.urlTemplate.replaceAll("{city}", city ?? "").replaceAll("{query}", encodeURIComponent(term));
}

export const searchKey = (term: string, city: string | null) => `${term}\u0000${city ?? ""}`;

/**
 * The searches for one run: demand terms first (newest first, up to 60% of
 * the run when a list exists), then the list — never searched before, then
 * longest ago. A search run in the last day is skipped; one that found
 * nothing new three times running waits a week and then goes last.
 */
export function planSearches(plan: ApifySearchPlan, demandTerms: string[], history: Map<string, SearchHistory>, now: Date = new Date()): PlannedSearch[] {
  const perRun = Math.min(plan.perRun ?? DEFAULT_PER_RUN, MAX_PER_RUN);
  const cities: (string | null)[] = plan.urlTemplate.includes("{city}") ? plan.cities : [null];
  const hours = (iso: string) => (now.getTime() - Date.parse(iso)) / 3_600_000;
  const barren = (h: SearchHistory | undefined) => !!h && h.recentNew.length >= BARREN_AFTER && h.recentNew.slice(0, BARREN_AFTER).every((n) => n === 0);
  const eligible = (term: string, city: string | null) => {
    const h = history.get(searchKey(term, city));
    if (!h) return true;
    if (hours(h.lastAt) < REPEAT_AFTER_HOURS) return false;
    return !barren(h) || hours(h.lastAt) >= BARREN_RETRY_DAYS * 24;
  };

  const out: PlannedSearch[] = [];
  const taken = new Set<string>();
  const add = (term: string, city: string | null, origin: PlannedSearch["origin"]) => {
    const key = searchKey(term, city);
    if (taken.has(key) || out.length >= perRun) return;
    taken.add(key);
    out.push({ term, city, url: searchUrl(plan, term, city), origin });
  };

  if (plan.fromDemand) {
    const demandCap = plan.queries.length ? Math.max(1, Math.ceil(perRun * 0.6)) : perRun;
    const terms = [...new Set(demandTerms.map(searchTerm).filter((t): t is string => !!t))];
    for (const term of terms) {
      for (const city of cities) {
        if (out.length >= demandCap) break;
        if (eligible(term, city)) add(term, city, "demand");
      }
      if (out.length >= demandCap) break;
    }
  }

  const list = plan.queries
    .map(searchTerm)
    .filter((t): t is string => !!t)
    .flatMap((term) => cities.map((city) => ({ term, city, h: history.get(searchKey(term, city)) })))
    .filter((c) => eligible(c.term, c.city))
    .sort((a, b) => {
      const rank = (c: typeof a) => (!c.h ? 0 : barren(c.h) ? 2 : 1);
      return rank(a) - rank(b) || (a.h ? Date.parse(a.h.lastAt) : 0) - (b.h ? Date.parse(b.h.lastAt) : 0);
    });
  for (const c of list) add(c.term, c.city, "list");
  return out;
}

/** The actor input for a run: the source's fixed input with the planned URLs put in place. */
export function runInput(baseInput: unknown, plan: ApifySearchPlan, searches: PlannedSearch[]): Record<string, unknown> {
  const base = baseInput && typeof baseInput === "object" && !Array.isArray(baseInput) ? { ...(baseInput as Record<string, unknown>) } : {};
  base[plan.inputPath ?? "startUrls"] = searches.map((s) => ((plan.urlShape ?? "object") === "object" ? { url: s.url } : s.url));
  return base;
}
