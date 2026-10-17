import { describe, it, expect } from "vitest";
import { healthFor, policyGaps, skipReason, type PolicySource, type RunnableSource } from "./source-policy";

const now = new Date("2026-10-16T12:00:00Z");
const reviewed: PolicySource = {
  kind: "search_venue",
  permission_basis: "public_search_index",
  robots_tos_assessment: "Queried through the search index only.",
  data_use_constraints: null,
  terms_reviewed_at: "2026-10-01T00:00:00Z",
  terms_review_due_at: "2027-04-01T00:00:00Z",
  apify_actor_id: null,
  apify_actor_version: null,
};

describe("policyGaps (PRD v2 FR-01: no activation until the permission policy is satisfied)", () => {
  it("clears a reviewed search venue", () => {
    expect(policyGaps(reviewed, now)).toEqual([]);
  });

  it("lists every gap of an unreviewed source at once", () => {
    expect(policyGaps({ ...reviewed, permission_basis: "none", robots_tos_assessment: "  ", terms_reviewed_at: null }, now)).toEqual([
      "no_permission_basis",
      "no_robots_tos_assessment",
      "terms_not_reviewed",
    ]);
  });

  it("treats a lapsed review as not satisfied", () => {
    expect(policyGaps({ ...reviewed, terms_review_due_at: "2026-10-15T00:00:00Z" }, now)).toEqual(["terms_review_expired"]);
    expect(policyGaps({ ...reviewed, terms_review_due_at: null }, now)).toEqual(["terms_review_expired"]);
  });

  it("holds connectors to official API terms and actors to explicit permission, pinned, with data-use limits", () => {
    expect(policyGaps({ ...reviewed, kind: "connector" }, now)).toEqual(["permission_basis_not_allowed_for_connector"]);
    expect(policyGaps({ ...reviewed, kind: "connector", permission_basis: "official_api_terms" }, now)).toEqual([]);
    // A search index is no permission to fetch the site with an actor.
    expect(policyGaps({ ...reviewed, kind: "apify_actor" }, now)).toEqual(["permission_basis_not_allowed_for_apify_actor", "no_data_use_constraints", "apify_actor_not_pinned"]);
    expect(
      policyGaps({ ...reviewed, kind: "apify_actor", permission_basis: "written_permission", data_use_constraints: "listings only", apify_actor_id: "acme/scraper", apify_actor_version: "1.2.3" }, now),
    ).toEqual([]);
    // "latest" is a moving tag, not the build that was reviewed.
    expect(
      policyGaps({ ...reviewed, kind: "apify_actor", permission_basis: "written_permission", data_use_constraints: "listings only", apify_actor_id: "acme/scraper", apify_actor_version: "latest" }, now),
    ).toEqual(["apify_actor_not_pinned"]);
  });
});

describe("skipReason", () => {
  const active: RunnableSource = { ...reviewed, status: "active", min_interval_minutes: null, max_daily_usd: null, last_run_at: null };

  it("runs an active, cleared source", () => {
    expect(skipReason(active, 0, now)).toBeNull();
  });

  it("re-checks the policy every run, then interval, then the daily cap", () => {
    expect(skipReason({ ...active, status: "proposed" }, 0, now)).toBe("status_proposed");
    expect(skipReason({ ...active, terms_review_due_at: "2026-10-01T00:00:00Z" }, 0, now)).toBe("terms_review_expired");
    expect(skipReason({ ...active, min_interval_minutes: 120, last_run_at: "2026-10-16T11:00:00Z" }, 0, now)).toBe("min_interval_not_elapsed");
    expect(skipReason({ ...active, min_interval_minutes: 30, last_run_at: "2026-10-16T11:00:00Z" }, 0, now)).toBeNull();
    expect(skipReason({ ...active, max_daily_usd: 0.05 }, 0.05, now)).toBe("daily_budget_reached");
    expect(skipReason({ ...active, max_daily_usd: 0.05 }, 0.04, now)).toBeNull();
  });
});

describe("healthFor", () => {
  it("is ok, degraded after a failure, failing after three in a row", () => {
    expect([0, 1, 2, 3, 7].map(healthFor)).toEqual(["ok", "degraded", "degraded", "failing", "failing"]);
  });
});
