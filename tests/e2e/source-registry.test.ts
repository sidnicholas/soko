import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { SearchProvider } from "@opportunity-os/connectors-sdk";
import {
  SourcePolicyError,
  closeDb,
  getDb,
  getSource,
  listSourceReviews,
  listSources,
  reviewSource,
  setSourceStatus,
  upsertSubmittedSource,
  type RegistrySource,
} from "@opportunity-os/db";
import { LlmGateway } from "@opportunity-os/llm-gateway";
import { SOURCE_POLICY_VERSION, policyGaps, runIntelCycle, vetSource } from "@opportunity-os/intel";

/**
 * PRD v2 FR-01 source registry against a live Postgres (migration 0025):
 * seeded built-ins and connectors, submission waits for review, the policy
 * gate, atomic review/activation/pause with audit and outbox events, per-search
 * run records, auto-pause, review expiry, and the compatibility view.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);
const DOMAIN = `src-${RUN}.example.com`;
const STAFF = { type: "user" as const, id: randomUUID() };
const SYSTEM = { type: "system" as const, id: null };
const POLICY = { policyGaps: (s: RegistrySource) => policyGaps(s), policyVersion: SOURCE_POLICY_VERSION };
const inSixMonths = () => new Date(Date.now() + 180 * 86_400_000).toISOString();

const events = async (sourceId: string) =>
  (await getDb().selectFrom("outbox").select("event_name").where("aggregate_type", "=", "source").where("aggregate_id", "=", sourceId).orderBy("created_at").execute()).map((e) => e.event_name);
const audits = async (sourceId: string) =>
  (await getDb().selectFrom("audit_events").select("action").where("entity_type", "=", "source").where("entity_id", "=", sourceId).orderBy("created_at").execute()).map((a) => a.action);

describe.skipIf(!HAS_DB)("source registry (live postgres)", () => {
  afterAll(async () => {
    // Test rows would add queries to later sweeps; the built-ins this file paused go back to active.
    await getDb().deleteFrom("source_registry").where("domain", "like", `%${RUN}.example.com`).execute();
    await getDb().updateTable("source_registry").set({ status: "active", status_reason: null, health: "unknown", consecutive_failures: 0 }).where("origin", "=", "builtin").execute();
    await closeDb();
  });

  it("seeds the built-in venues and connectors as reviewed, active sources", async () => {
    const all = await listSources();
    const builtin = all.filter((s) => s.origin === "builtin");
    expect(builtin.length).toBeGreaterThanOrEqual(10);
    for (const s of builtin) expect(policyGaps(s)).toEqual([]);
    const connectors = all.filter((s) => s.kind === "connector").map((s) => s.external_id).sort();
    expect(connectors).toEqual(["ebay-browse", "reverb-listings"]);
    expect((await listSourceReviews(builtin[0]!.id))[0]).toMatchObject({ decision: "approved", reviewer_label: "migration 0025" });
  });

  it("keeps a submission out of the pool until a review satisfies the policy, recording each step", async () => {
    const [demand] = vetSource({ source_id: `SRC-${RUN}`, name: "Test Board", domain: DOMAIN, side: "demand", sector: "Lab equipment", access_method: "public listings" }).vetted;
    const { source, created } = await upsertSubmittedSource({ ...demand!, origin: "agent" }, { type: "agent", id: null });
    expect(created).toBe(true);
    expect(source).toMatchObject({ status: "proposed", status_reason: "awaiting_policy_review", permission_basis: "public_search_index", kind: "search_venue" });
    expect(policyGaps(source)).toEqual(["no_robots_tos_assessment", "terms_not_reviewed"]);

    // Resuming a source whose policy is not satisfied is refused; nothing changes.
    await expect(setSourceStatus(source.id, "active", null, STAFF, POLICY)).rejects.toBeInstanceOf(SourcePolicyError);
    expect((await getSource(source.id))!.status).toBe("proposed");

    // An approval that leaves a gap keeps it proposed, with the gap as its reason.
    const partial = await reviewSource({
      sourceId: source.id, decision: "approved", permissionBasis: "public_search_index", robotsTosAssessment: null, dataUseConstraints: null,
      termsReviewDueAt: inSixMonths(), notes: null, reviewer: STAFF, reviewerLabel: null, ...POLICY,
    });
    expect(partial!.source).toMatchObject({ status: "proposed", status_reason: "no_robots_tos_assessment" });

    const full = await reviewSource({
      sourceId: source.id, decision: "approved", permissionBasis: "public_search_index", robotsTosAssessment: "Search index only; no fetch.", dataUseConstraints: null,
      termsReviewDueAt: inSixMonths(), notes: "ok", reviewer: STAFF, reviewerLabel: null, ...POLICY,
    });
    expect(full!.source).toMatchObject({ status: "active", status_reason: null });
    expect(full!.gaps).toEqual([]);

    // Every step is on the audit chain and in the outbox, committed with the change.
    expect(await audits(source.id)).toEqual(["source.submitted", "source.reviewed", "source.reviewed", "source.activated"]);
    expect(await events(source.id)).toEqual(["source.reviewed.v1", "source.reviewed.v1", "source.activated.v1"]);
    expect((await listSourceReviews(source.id)).map((r) => r.decision)).toEqual(["approved", "approved"]);

    // A resubmission refreshes the description but never the status or review.
    const again = await upsertSubmittedSource({ ...demand!, name: "Test Board (renamed)", status: "proposed", origin: "agent" }, { type: "agent", id: null });
    expect(again).toMatchObject({ created: false, source: { name: "Test Board (renamed)", status: "active" } });
  });

  it("records every search, then pauses an active source that keeps yielding nothing", async () => {
    // Pause the built-ins so the pool is only this file's source.
    for (const s of await listSources({ kind: "search_venue", status: "active" })) {
      if (!s.domain.endsWith(`${RUN}.example.com`)) await setSourceStatus(s.id, "paused", "test_isolation", SYSTEM, POLICY);
    }
    const source = (await listSources({ kind: "search_venue" })).find((s) => s.domain === DOMAIN)!;
    const query = `site:${DOMAIN} lab equipment request`;
    const searched: string[] = [];
    const search: SearchProvider = { id: "stub", costPerQueryUsd: 0.005, search: async (q) => (searched.push(q.query), []) };
    const run = () => runIntelCycle({ search, llm: LlmGateway.default(), dailyBudgetUsd: 1000, runsPerDay: 1, queriesPerRun: 50, maxAssessments: 0 });

    await run();
    expect(searched).toEqual([query]);
    const runs = await getDb().selectFrom("source_runs").select(["query", "results", "leads", sql<number>`cost_usd::float`.as("cost")]).where("source_id", "=", source.id).execute();
    expect(runs).toEqual([{ query, results: 0, leads: 0, cost: 0.005 }]);
    expect((await getSource(source.id))!).toMatchObject({ health: "ok", consecutive_failures: 0 });

    await run();
    expect((await getSource(source.id))!.status).toBe("active");
    await run();
    expect(await getSource(source.id)).toMatchObject({ status: "paused", status_reason: "no_leads_after_repeated_searches" });
    expect((await events(source.id)).at(-1)).toBe("source.paused.v1");

    searched.length = 0;
    await run();
    expect(searched).toEqual([]);
  });

  it("pauses an active source whose review has lapsed instead of searching it", async () => {
    const [supply] = vetSource({ name: "Lapsed", domain: `lapsed-${RUN}.example.com`, side: "supply", sector: "Pallets", access_method: "public" }).vetted;
    const { source } = await upsertSubmittedSource({ ...supply!, origin: "staff_upload" }, STAFF);
    await reviewSource({
      sourceId: source.id, decision: "approved", permissionBasis: "public_search_index", robotsTosAssessment: "Index only.", dataUseConstraints: null,
      termsReviewDueAt: inSixMonths(), notes: null, reviewer: STAFF, reviewerLabel: null, ...POLICY,
    });
    await getDb().updateTable("source_registry").set({ terms_review_due_at: new Date(Date.now() - 60_000).toISOString() }).where("id", "=", source.id).execute();

    const searched: string[] = [];
    const search: SearchProvider = { id: "stub", costPerQueryUsd: 0, search: async (q) => (searched.push(q.query), []) };
    await runIntelCycle({ search, llm: LlmGateway.default(), dailyBudgetUsd: 1000, runsPerDay: 1, queriesPerRun: 50, maxAssessments: 0 });
    expect(searched.some((q) => q.includes(`lapsed-${RUN}`))).toBe(false);
    expect(await getSource(source.id)).toMatchObject({ status: "paused", status_reason: "terms_review_expired" });
  });

  it("keeps the pre-0025 table name readable for code deployed before the migration", async () => {
    const rows = await sql<{ domain: string }>`select domain from intel_query_sources where domain = ${DOMAIN}`.execute(getDb());
    expect(rows.rows).toEqual([{ domain: DOMAIN }]);
  });
});
