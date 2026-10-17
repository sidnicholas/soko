import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { closeDb, getCrmLink, getDb, getIntelCandidate, insertIntelLead, upsertIntelCandidate } from "@opportunity-os/db";
import { resetConfig } from "@opportunity-os/config";
import { CrmService } from "../../apps/api/src/crm/crm.service";

/**
 * ADR-040 end to end against a live Postgres with Pipedrive stubbed: elevate a
 * candidate (deal + note + link, once), then the webhook reports stage and
 * outcome back — each event once, in order, with basic auth.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);
// Unique per run: deal ids key the elevation event, and suites can share a database.
const DEAL = String(Math.floor(Math.random() * 1e9) + 1e5);
const auth = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

describe.skipIf(!HAS_DB)("Pipedrive (live postgres, stubbed API)", () => {
  const realFetch = globalThis.fetch;
  const saved = { ...process.env };
  const calls: { url: string; body: unknown }[] = [];
  let candidateId = "";
  const crm = new CrmService();

  beforeAll(async () => {
    Object.assign(process.env, { PIPEDRIVE_COMPANY_DOMAIN: "acme", PIPEDRIVE_API_TOKEN: "tok", PIPEDRIVE_WEBHOOK_USER: "pd", PIPEDRIVE_WEBHOOK_PASSWORD: "secret", PUBLIC_API_BASE_URL: "https://api.example.com" });
    resetConfig();
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      const path = new URL(String(url)).pathname;
      const data = path === "/api/v2/deals" ? { id: Number(DEAL), status: "open", stage_id: 1, value: 300, currency: "USD" } : { id: 1 };
      return { ok: true, status: 200, json: async () => ({ success: true, data }) } as Response;
    }) as typeof fetch;

    const runId = (await getDb().insertInto("intel_runs").values({ notes: "{}" }).returning("id").executeTakeFirstOrThrow()).id;
    const leadId = await insertIntelLead({
      runId,
      kind: "supply", title: "120 office chairs", summary: "Closeout", url: `https://pd-${RUN}.example.com/chairs`, urlHash: `pd-${RUN}`,
      hostname: `pd-${RUN}.example.com`, query: "q", searchProvider: "stub", publishedAt: null, ageText: null, item: null, category: null, quantity: null,
      location: null, deadline: null, priceMinor: null, currency: null, urgency: "high", credibility: 0.9, contact: null, facts: [], oppositeQueries: [],
    });
    candidateId = await upsertIntelCandidate({
      runId, leadId: leadId!, counterUrl: null, counterSummary: null, serviceKey: null, matchKind: "supply_to_demand",
      title: "Broker the chair closeout", matchRationale: "r", verificationStatus: "verified", freshness: 1,
      economics: { deal: { mode: "brokerage", netProfitUsd: [200, 400], probability: [0.3, 0.5], daysToCash: [10, 20], capitalRequiredUsd: 0, costs: [] } },
      monetization: { payer: "Seller", mechanism: "commission" }, regulatoryFlags: [], fraudFlags: [], contact: null, evLowUsd: 60, evHighUsd: 200,
      confidence: "high", score: 70, explanation: {}, outreach: {}, bucket: "verify_next", rejectReason: null,
    });
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    process.env = saved;
    resetConfig();
    await getDb().deleteFrom("crm_links").where("subject_id", "=", candidateId).execute();
    await getDb().deleteFrom("intel_leads").where("url_hash", "=", `pd-${RUN}`).execute();
    await closeDb();
  });

  it("elevates a candidate once: a deal valued at mid net profit, a note, and a link", async () => {
    const first = await crm.elevateCandidate(candidateId, randomUUID());
    expect(first).toMatchObject({ created: true, link: { external_id: DEAL, external_url: `https://acme.pipedrive.com/deal/${DEAL}`, external_status: "open" } });
    const deal = calls.find((c) => c.url.endsWith("/api/v2/deals"))!.body as Record<string, unknown>;
    expect(deal).toMatchObject({ title: "Broker the chair closeout", value: 300, currency: "USD" });
    expect(calls.some((c) => c.url.endsWith("/api/v1/notes") && (c.body as { deal_id: number }).deal_id === Number(DEAL))).toBe(true);

    const again = await crm.elevateCandidate(candidateId, randomUUID());
    expect(again.created).toBe(false);
    expect(calls.filter((c) => c.url.endsWith("/api/v2/deals"))).toHaveLength(1);
    const events = await getDb().selectFrom("outbox").select("event_name").where("aggregate_id", "=", candidateId).where("event_name", "=", "crm.deal_elevated.v1").execute();
    expect(events).toHaveLength(1);
  });

  it("asks for redelivery of an event for a deal still being elevated, then applies it", async () => {
    // A second candidate whose elevation is in flight (link reserved, no deal id yet).
    const { beginCrmLink, completeCrmLink } = await import("@opportunity-os/db");
    const otherId = randomUUID();
    const { link } = await beginCrmLink("pipedrive", "intel_candidate", otherId, null);
    const early = { meta: { action: "create", entity: "deal", entity_id: 9100, id: `early-${RUN}`, timestamp: "2026-10-17T00:00:00Z" }, data: { status: "open", stage_id: 1 } };
    await expect(crm.handleWebhook(auth("pd", "secret"), early)).rejects.toThrow("redeliver");
    // Not recorded, so the redelivery is processed once the link exists.
    await completeCrmLink(link.id, { externalId: "9100", externalUrl: "https://acme.pipedrive.com/deal/9100", status: "open", stageId: 1, value: 10, currency: "USD" }, null);
    expect((await crm.handleWebhook(auth("pd", "secret"), early)).outcome).toBe("applied");
    await getDb().deleteFrom("crm_links").where("id", "=", link.id).execute();
  });

  it("refuses a webhook without the right basic auth", async () => {
    await expect(crm.handleWebhook(undefined, {})).rejects.toThrow("Invalid Pipedrive webhook credentials");
    await expect(crm.handleWebhook(auth("pd", "wrong"), {})).rejects.toThrow("Invalid Pipedrive webhook credentials");
  });

  it("applies stage and outcome back, once per event and in order", async () => {
    const meta = (id: string, ts: string, action = "change") => ({ action, entity: "deal", entity_id: Number(DEAL), id, timestamp: ts });
    const ok = auth("pd", "secret");

    expect((await crm.handleWebhook(ok, { meta: meta(`a-${RUN}`, "2026-10-16T10:00:00Z"), data: { status: "open", stage_id: 2, value: 300, currency: "USD" }, previous: { stage_id: 1 } })).outcome).toBe("applied");
    expect((await getCrmLink("pipedrive", "intel_candidate", candidateId))!.external_stage_id).toBe(2);
    expect((await getIntelCandidate(candidateId))!.user_status).toBe("contacted");

    // Pipedrive retries: the same event id changes nothing the second time.
    expect((await crm.handleWebhook(ok, { meta: meta(`a-${RUN}`, "2026-10-16T10:00:00Z"), data: { status: "open", stage_id: 2 } })).outcome).toBe("duplicate");

    expect((await crm.handleWebhook(ok, { meta: meta(`b-${RUN}`, "2026-10-16T11:00:00Z"), data: { status: "won", value: 450, currency: "USD" }, previous: { status: "open" } })).outcome).toBe("applied");
    const won = (await getIntelCandidate(candidateId))!;
    expect(won).toMatchObject({ user_status: "won", outcome_reason: "completed", outcome_note: "Won in Pipedrive" });
    expect(Number(won.realized_usd)).toBe(450);

    // An older event arriving late does not undo the win.
    expect((await crm.handleWebhook(ok, { meta: meta(`c-${RUN}`, "2026-10-16T09:00:00Z"), data: { status: "lost", lost_reason: "late" } })).outcome).toBe("stale");
    expect((await getIntelCandidate(candidateId))!.user_status).toBe("won");

    // Reopened, then lost with a reason.
    await crm.handleWebhook(ok, { meta: meta(`d-${RUN}`, "2026-10-16T12:00:00Z"), data: { status: "open" }, previous: { status: "won" } });
    expect((await getIntelCandidate(candidateId))!.user_status).toBe("contacted");
    await crm.handleWebhook(ok, { meta: meta(`e-${RUN}`, "2026-10-16T13:00:00Z"), data: { status: "lost", lost_reason: "Buyer went elsewhere" }, previous: { status: "open" } });
    expect((await getIntelCandidate(candidateId))!).toMatchObject({ user_status: "lost", outcome_note: "Lost in Pipedrive: Buyer went elsewhere" });

    // A deal we never elevated is acknowledged and ignored.
    expect((await crm.handleWebhook(ok, { meta: { ...meta(`f-${RUN}`, "2026-10-16T14:00:00Z"), entity_id: 1 }, data: { status: "won" } })).outcome).toBe("unknown_deal");

    const synced = await getDb().selectFrom("outbox").select("event_name").where("aggregate_id", "=", candidateId).where("event_name", "=", "crm.deal_synced.v1").execute();
    expect(synced).toHaveLength(4);
  });
});
