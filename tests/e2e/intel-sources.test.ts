import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { SearchProvider } from "@opportunity-os/connectors-sdk";
import { closeDb, getDb, listIntelQuerySources, setIntelQuerySourceStatus, upsertIntelQuerySource } from "@opportunity-os/db";
import { LlmGateway } from "@opportunity-os/llm-gateway";
import { runIntelCycle, vetSource } from "@opportunity-os/intel";

/**
 * Runtime search sources against a live Postgres: a vetted source is stored,
 * a resubmission never changes its status, an active one is searched by the
 * sweep, and one that keeps yielding nothing is paused.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);
const DOMAIN = `src-${RUN}.example.com`;

describe.skipIf(!HAS_DB)("intel query sources (live postgres)", () => {
  afterAll(async () => {
    // Active rows would add queries to every later sweep in this database.
    await getDb().deleteFrom("intel_query_sources").where("domain", "like", `%${RUN}.example.com`).execute();
    await closeDb();
  });

  it("stores a vetted source and keeps its status on resubmission", async () => {
    const [demand, supply] = vetSource({ source_id: `SRC-${RUN}`, name: "Test Board", domain: DOMAIN, side: "both", sector: "Lab equipment", access_method: "public listings" }).vetted;
    const first = await upsertIntelQuerySource({ ...demand!, origin: "agent" });
    expect(first.created).toBe(true);
    expect(first.source).toMatchObject({ domain: DOMAIN, orientation: "demand", topics: ["lab equipment request"], status: "active", status_reason: null, origin: "agent" });
    await upsertIntelQuerySource({ ...supply!, origin: "agent" });

    await setIntelQuerySourceStatus(first.source.id, "paused", "paused_by_staff");
    // The agent reports it again, renamed: details refresh, the pause stands, derived topics do not overwrite.
    const again = await upsertIntelQuerySource({ ...demand!, name: "Test Board (renamed)", topics: ["something else"], topicsExplicit: false, origin: "agent" });
    expect(again.created).toBe(false);
    expect(again.source).toMatchObject({ name: "Test Board (renamed)", status: "paused", status_reason: "paused_by_staff", topics: ["lab equipment request"] });
    // Topics the submitter did supply replace the stored ones.
    const retopic = await upsertIntelQuerySource({ ...demand!, topics: ["wanted centrifuge"], topicsExplicit: true, origin: "agent" });
    expect(retopic.source.topics).toEqual(["wanted centrifuge"]);

    const mine = (await listIntelQuerySources()).filter((s) => s.domain === DOMAIN);
    expect(mine.map((s) => [s.orientation, s.status])).toEqual([["supply", "active"], ["demand", "paused"]]);
    expect((await listIntelQuerySources("active")).some((s) => s.domain === DOMAIN && s.orientation === "demand")).toBe(false);
  });

  it("searches an active source and pauses it after three searches without a lead", async () => {
    const searched: string[] = [];
    // Returns nothing, so no model call is ever made.
    const search: SearchProvider = { id: "stub", costPerQueryUsd: 0, search: async (q) => (searched.push(q.query), []) };
    const run = () => runIntelCycle({ search, llm: LlmGateway.default(), dailyBudgetUsd: 1000, runsPerDay: 1, queriesPerRun: 999, maxAssessments: 0 });
    const query = `site:${DOMAIN} lab equipment for sale`;
    const status = async () => (await listIntelQuerySources()).find((s) => s.domain === DOMAIN && s.orientation === "supply")!;

    await run();
    expect(searched).toContain(query);
    // The paused demand row contributes nothing.
    expect(searched.some((q) => q.startsWith(`site:${DOMAIN}`) && q !== query)).toBe(false);
    await run();
    expect((await status()).status).toBe("active");
    await run();
    expect(await status()).toMatchObject({ status: "paused", status_reason: "no_leads_after_repeated_searches" });

    searched.length = 0;
    await run();
    expect(searched).not.toContain(query);
  });
});
