import { describe, it, expect } from "vitest";
import { stageOnePool, stageOneQueries } from "./queries";
import { SourceSubmissionSchema, deriveTopic, isUnproductive, normalizeDomain, orientationsForSide, sourceQueries, vetSource, type SubmittedSource } from "./sources";

const base: SubmittedSource = {
  source_id: "SRC-1",
  name: "Surplus Record",
  domain: "surplusrecord.com",
  side: "both",
  sector: "Industrial surplus equipment",
  signal_type: "Equipment listings and wanted requests",
  access_method: "public search; dealer network",
};

describe("normalizeDomain", () => {
  it("reduces a URL to a bare lowercase host", () => {
    expect(normalizeDomain("https://www.Example.com/path?q=1")).toBe("example.com");
    expect(normalizeDomain("projects.worldbank.org")).toBe("projects.worldbank.org");
  });

  it("rejects anything that could not be a site: filter", () => {
    for (const bad of ["", "localhost", "not a domain", "example.com OR site:evil.com", "exa mple.com", "-bad.com"]) expect(normalizeDomain(bad)).toBeUndefined();
  });
});

describe("vetSource", () => {
  it("lists a both-sided source on each side, searched from the next run", () => {
    const { vetted, rejected } = vetSource(base);
    expect(rejected).toBeNull();
    expect(vetted.map((v) => [v.orientation, v.status, v.topics])).toEqual([
      ["demand", "active", ["industrial surplus equipment request"]],
      ["supply", "active", ["industrial surplus equipment for sale"]],
    ]);
    expect(vetted[0]).toMatchObject({ externalId: "SRC-1", domain: "surplusrecord.com", topicsExplicit: false });
  });

  it("maps side variants and drops what is neither demand nor supply", () => {
    expect(orientationsForSide("demand-signals")).toEqual(["demand"]);
    expect(orientationsForSide("supply-directory")).toEqual(["supply"]);
    expect(vetSource({ ...base, side: "news" })).toEqual({ vetted: [], rejected: "unknown_side" });
    expect(vetSource({ ...base, domain: "not a domain" })).toEqual({ vetted: [], rejected: "invalid_domain" });
  });

  it("holds sources a search index cannot show, with the reason", () => {
    const held = (over: Partial<SubmittedSource>) => vetSource({ ...base, side: "demand", ...over }).vetted.map((v) => [v.status, v.statusReason]);
    expect(held({ access_method: "paid subscription" })).toEqual([["paused", "no_public_pages"]]);
    expect(held({ access_method: "documented REST API" })).toEqual([["paused", "no_public_pages"]]);
    expect(held({ domain: "eva.virginia.gov", access_method: "public bulletin board" })).toEqual([["paused", "government_portal_screened"]]);
    expect(held({ domain: "emarketplace.state.pa.us", access_method: "public portal" })).toEqual([["paused", "government_portal_screened"]]);
    expect(held({ domain: "upwork.com" })).toEqual([["paused", "already_in_builtin_pool"]]);
    expect(held({ domain: "ebay.com", side: "supply" })).toEqual([["paused", "covered_by_connector"]]);
    expect(held({ domain: "docs.ted.europa.eu", access_method: "public search" })).toEqual([["paused", "documentation_host"]]);
    expect(held({ access_method: "documented public JSON API" })).toEqual([["paused", "no_public_pages"]]);
  });

  it("keeps a side out when the reviewer holds it, without touching the other side", () => {
    const { vetted } = vetSource({ ...base, hold: { supply: "profiles_not_offers" } });
    expect(vetted.map((v) => [v.orientation, v.status, v.statusReason])).toEqual([
      ["demand", "active", null],
      ["supply", "paused", "profiles_not_offers"],
    ]);
  });

  it("holds supplier directories on the supply side only", () => {
    const { vetted } = vetSource({ ...base, domain: "manufacturers.directory", signal_type: "Manufacturer profiles, RFQs, catalogs", access_method: "public directory; account for RFQs" });
    expect(vetted.map((v) => [v.orientation, v.status, v.statusReason])).toEqual([
      ["demand", "active", null],
      ["supply", "paused", "directory_not_live_offers"],
    ]);
  });

  it("uses submitted topics, stripped of quotes and search operators", () => {
    const { vetted } = vetSource({ ...base, side: "demand", demand_topics: ['"wanted" forklift site:evil.com', "wanted forklift"] });
    expect(vetted[0]).toMatchObject({ topics: ["wanted forklift evil.com", "wanted forklift"], topicsExplicit: true });
    for (const q of sourceQueries(vetted[0]!)) expect(q.query.match(/site:/g)).toHaveLength(1);
  });

  it("accepts the agent's report shape or a bare array", () => {
    expect(SourceSubmissionSchema.safeParse({ report_date: "2026-10-12", source_count: 1, sources: [{ ...base, discovered_at: "2026-10-12" }] }).success).toBe(true);
    expect(SourceSubmissionSchema.safeParse([base]).success).toBe(true);
    expect(SourceSubmissionSchema.safeParse({ sources: [] }).success).toBe(false);
  });
});

describe("deriveTopic", () => {
  it("builds a short plain phrase from the sector", () => {
    expect(deriveTopic("demand", "Freelance/professional services")).toBe("freelance professional services request");
    expect(deriveTopic("supply", "Laboratory equipment")).toBe("laboratory equipment for sale");
    expect(deriveTopic("demand", undefined)).toBe("request");
  });
});

describe("runtime sources in the stage-1 pool", () => {
  const extra = sourceQueries({ domain: "surplusrecord.com", orientation: "supply", topics: ["industrial surplus equipment for sale"] });

  it("joins the built-in pool without duplicating a query", () => {
    const builtin = stageOnePool();
    const pool = stageOnePool([...extra, ...extra, builtin[0]!]);
    expect(pool).toHaveLength(builtin.length + 1);
    expect(pool.at(-1)).toEqual({ query: "site:surplusrecord.com industrial surplus equipment for sale", orientation: "supply", freshness: "month" });
  });

  it("gets searched: a supply source fills the otherwise empty supply lane", () => {
    expect(stageOneQueries(0, 8).some((q) => q.orientation === "supply")).toBe(false);
    expect(stageOneQueries(0, 8, extra).filter((q) => q.orientation === "supply").map((q) => q.query)).toEqual([extra[0]!.query]);
  });
});

describe("isUnproductive", () => {
  const y = (searches: number, leads: number) => ({ searches, leads });

  it("is true only once every query was searched three times with no lead at all", () => {
    expect(isUnproductive(["a", "b"], new Map([["a", y(3, 0)], ["b", y(4, 0)]]))).toBe(true);
    expect(isUnproductive(["a", "b"], new Map([["a", y(3, 0)], ["b", y(2, 0)]]))).toBe(false);
    expect(isUnproductive(["a", "b"], new Map([["a", y(3, 0)], ["b", y(3, 1)]]))).toBe(false);
    expect(isUnproductive(["a"], new Map())).toBe(false);
    expect(isUnproductive([], new Map())).toBe(false);
  });
});
