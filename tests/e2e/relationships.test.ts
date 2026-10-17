import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  addChannel,
  addMemory,
  closeDb,
  correctMemory,
  createParty,
  deleteMemory,
  getDb,
  getPartyDetail,
  insertIntelLead,
  isSuppressed,
  listParties,
  listPartiesForSubject,
  purgeParty,
  recordConsent,
  upsertIntelCandidate,
  type Actor,
} from "@opportunity-os/db";
import { resetConfig } from "@opportunity-os/config";
import { mayContact, type FreshnessProbes } from "@opportunity-os/relationship";
import { CrmService } from "../../apps/api/src/crm/crm.service";
import { retentionCycle } from "../../apps/worker-lifecycle/src/retention";

/**
 * PRD v2 FR-06 / ADR-041 against a live Postgres: contacts with channels,
 * append-only consent, memories with correction history, links to deals,
 * the 90-day archive with freshness checks and purge (opt-outs survive as
 * hashes), data-subject deletion, and the Pipedrive person/org copy on an
 * elevated deal (Pipedrive stubbed).
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);
const OP: Actor = { type: "user", id: randomUUID() };
const DOMAIN = `rel-${RUN}.example.com`;
const DEAL = String(Math.floor(Math.random() * 1e9) + 1e5);

async function newCandidate(): Promise<string> {
  const runId = (await getDb().insertInto("intel_runs").values({ notes: "{}" }).returning("id").executeTakeFirstOrThrow()).id;
  const tag = randomUUID().slice(0, 8);
  const leadId = await insertIntelLead({
    runId,
    kind: "supply", title: "Pallets of returns", summary: "Returns", url: `https://${DOMAIN}/${tag}`, urlHash: `rel-${RUN}-${tag}`,
    hostname: DOMAIN, query: "q", searchProvider: "stub", publishedAt: null, ageText: null, item: null, category: null, quantity: null,
    location: null, deadline: null, priceMinor: null, currency: null, urgency: "high", credibility: 0.9, contact: null, facts: [], oppositeQueries: [],
  });
  return upsertIntelCandidate({
    runId, leadId: leadId!, counterUrl: null, counterSummary: null, serviceKey: null, matchKind: "supply_to_demand",
    title: "Broker the returns", matchRationale: "r", verificationStatus: "verified", freshness: 1,
    economics: { deal: { mode: "brokerage", netProfitUsd: [200, 400], probability: [0.3, 0.5], daysToCash: [10, 20], capitalRequiredUsd: 0, costs: [] } },
    monetization: { payer: "Seller", mechanism: "commission" }, regulatoryFlags: [], fraudFlags: [], contact: null, evLowUsd: 60, evHighUsd: 200,
    confidence: "high", score: 70, explanation: {}, outreach: {}, bucket: "verify_next", rejectReason: null,
  });
}

const events = async (partyId: string) =>
  (await getDb().selectFrom("outbox").select("payload").where("event_name", "=", "relationship.memory_updated.v1").where("aggregate_id", "=", partyId).execute()).map((e) => (e.payload as { change: string }).change);

describe.skipIf(!HAS_DB)("relationships (live postgres)", () => {
  let candidateId = "";
  const partyIds: string[] = [];

  beforeAll(async () => {
    candidateId = await newCandidate();
  });

  afterAll(async () => {
    if (partyIds.length) await getDb().deleteFrom("counterparties").where("id", "in", partyIds).execute();
    await getDb().deleteFrom("crm_links").where("subject_id", "=", candidateId).execute();
    await getDb().deleteFrom("intel_leads").where("hostname", "=", DOMAIN).execute();
    await closeDb();
  });

  it("creates an organization and a person in it, with normalized channels and a link to the candidate", async () => {
    const org = await createParty({ type: "organization", displayName: "Acme Returns", website: `https://www.${DOMAIN}/` }, OP);
    partyIds.push(org.party.id);
    expect(org.channels.map((c) => [c.kind, c.normalized_value])).toEqual([["website", DOMAIN]]);

    const jo = await createParty(
      {
        type: "person", displayName: "  Jo Rivera ", organizationId: org.party.id, roleTitle: "Buyer",
        channels: [{ kind: "email", value: `Jo@${DOMAIN.toUpperCase()}`, isPrimary: true }, { kind: "phone", value: "+1 (555) 010-2030" }],
        link: { subjectType: "intel_candidate", subjectId: candidateId, role: "seller" },
      },
      OP,
    );
    partyIds.push(jo.party.id);
    expect(jo.party).toMatchObject({ display_name: "Jo Rivera", organization_name: "Acme Returns", status: "active" });
    expect(jo.channels.map((c) => c.normalized_value).sort()).toEqual([`jo@${DOMAIN}`, "+15550102030"].sort());
    // The same address again is the same channel.
    await addChannel(jo.party.id, { kind: "email", value: `mailto:jo@${DOMAIN}` }, OP);
    expect((await getPartyDetail(jo.party.id))!.channels).toHaveLength(2);
    await expect(addChannel(jo.party.id, { kind: "email", value: "not-an-email" }, OP)).rejects.toThrow("Not a valid email");
    // A person cannot be another person's organization.
    await expect(createParty({ type: "person", displayName: "X", organizationId: jo.party.id }, OP)).rejects.toThrow("organization");

    expect((await listPartiesForSubject("intel_candidate", candidateId)).map((p) => [p.display_name, p.role])).toEqual([["Jo Rivera", "seller"]]);
    expect((await listParties({ q: `jo@${DOMAIN}` })).map((p) => p.id)).toEqual([jo.party.id]);
    expect((await getPartyDetail(org.party.id))!.members.map((m) => m.display_name)).toEqual(["Jo Rivera"]);
  });

  it("keeps consent append-only: nothing assumed, the latest decision in force, an opt-out wins", async () => {
    const jo = partyIds[1]!;
    let d = (await getPartyDetail(jo))!;
    expect(d.outreach.find((o) => o.channel_kind === "email")!.status).toBe("none");
    expect(mayContact(d.consents, "email", "outreach")).toEqual({ allowed: false, reason: "no_consent_recorded" });

    await recordConsent(jo, { channelKind: "email", purpose: "outreach", status: "granted", basis: "explicit", evidence: "Replied asking for offers" }, OP);
    d = (await getPartyDetail(jo))!;
    expect(mayContact(d.consents, "email", "outreach").allowed).toBe(true);
    expect(mayContact(d.consents, "phone", "outreach").allowed).toBe(false);

    await recordConsent(jo, { channelKind: "any", purpose: "outreach", status: "opted_out", basis: "none", evidence: "Asked to stop" }, OP);
    d = (await getPartyDetail(jo))!;
    expect(d.consents).toHaveLength(2);
    expect(d.outreach.every((o) => o.status === "opted_out")).toBe(true);
    expect(mayContact(d.consents, "email", "outreach")).toEqual({ allowed: false, reason: "consent_opted_out" });
    expect(await events(jo)).toEqual(expect.arrayContaining(["party", "channel", "consent"]));
  });

  it("corrects a memory by superseding it, and deletes a memory with its history", async () => {
    const jo = partyIds[1]!;
    const first = await addMemory(jo, { kind: "buying_cycle", content: "Buys monthly", sourceType: "operator", sourceLabel: "source_fact", confidence: 0.8 }, OP);
    const fixed = await correctMemory(jo, first.id, { kind: "buying_cycle", content: "Buys quarterly", sourceType: "operator", sourceLabel: "source_fact" }, OP);
    expect((await getPartyDetail(jo))!.memories.map((m) => m.content)).toEqual(["Buys quarterly"]);
    const old = await getDb().selectFrom("relationship_memories").select(["status", "superseded_by", "content"]).where("id", "=", first.id).executeTakeFirstOrThrow();
    expect(old).toMatchObject({ status: "superseded", superseded_by: fixed.id, content: "Buys monthly" });
    await expect(correctMemory(jo, first.id, { kind: "note", content: "x", sourceType: "operator", sourceLabel: "unknown" }, OP)).rejects.toThrow("Only an active memory");

    await deleteMemory(jo, fixed.id, OP);
    const rows = await getDb().selectFrom("relationship_memories").select(["status", "content"]).where("id", "in", [first.id, fixed.id]).execute();
    expect(rows).toEqual([{ status: "deleted", content: "" }, { status: "deleted", content: "" }]);
    expect((await getPartyDetail(jo))!.memories).toHaveLength(0);
  });

  it("archives after 90 days idle, keeps an unverifiable party, purges a stale one and keeps its opt-out as a hash", async () => {
    const [orgId, joId] = partyIds as [string, string];
    const quiet = await createParty({ type: "person", displayName: "Phone Only", channels: [{ kind: "phone", value: "+15550109999" }] }, OP);
    partyIds.push(quiet.party.id);
    const ids = [orgId, joId, quiet.party.id];
    await getDb().updateTable("counterparties").set({ last_activity_at: new Date(Date.now() - 91 * 86_400_000).toISOString() }).where("id", "in", ids).execute();

    // Our domain is gone; anything else cannot be told (so other suites' parties are left alone).
    const probes: FreshnessProbes = {
      websiteReachable: async (h) => (h.startsWith(DOMAIN) ? false : null),
      emailDomainAcceptsMail: async (d) => (d === DOMAIN ? false : null),
    };
    const first = await retentionCycle(probes);
    expect(first.archived).toBeGreaterThanOrEqual(3);
    const archived = await getDb().selectFrom("counterparties").select(["id", "status", "freshness_due_at"]).where("id", "in", ids).execute();
    expect(archived.every((p) => p.status === "archived" && p.freshness_due_at)).toBe(true);
    expect(await events(joId)).toContain("archived");

    // The check comes due.
    await getDb().updateTable("counterparties").set({ freshness_due_at: new Date(Date.now() - 1000).toISOString() }).where("id", "in", ids).execute();
    await retentionCycle(probes);
    const left = await getDb().selectFrom("counterparties").select(["id", "status", "freshness_due_at", "freshness_checked_at"]).where("id", "in", ids).execute();
    // Org (website gone) and Jo (email domain gone) were stale; the phone-only party cannot be checked and stays archived.
    expect(left.map((p) => p.id)).toEqual([quiet.party.id]);
    expect(left[0]!.freshness_checked_at).not.toBeNull();
    expect(Date.parse(left[0]!.freshness_due_at!)).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    // Jo had opted out: the email and phone are suppressed after the purge; the org's website is not kept.
    expect(await isSuppressed("email", `jo@${DOMAIN}`)).toBe(true);
    expect(await isSuppressed("phone", "+15550102030")).toBe(true);
    expect(await isSuppressed("website", DOMAIN)).toBe(false);
    expect(await listPartiesForSubject("intel_candidate", candidateId)).toEqual([]);

    // Entered again later, the address comes back opted out, never contactable.
    const again = await createParty({ type: "person", displayName: "Jo R.", channels: [{ kind: "email", value: `jo@${DOMAIN}` }] }, OP);
    partyIds.push(again.party.id);
    expect(again.outreach.find((o) => o.channel_kind === "email")!.status).toBe("opted_out");
  });

  it("restores an archived party on any activity", async () => {
    const quiet = partyIds[2]!;
    await addMemory(quiet, { kind: "note", content: "Called back", sourceType: "operator", sourceLabel: "source_fact" }, OP);
    expect((await getPartyDetail(quiet))!.party).toMatchObject({ status: "active", archived_at: null, freshness_due_at: null });
  });

  it("honors a deletion request: everything removed, every email and phone suppressed", async () => {
    const p = await createParty({ type: "person", displayName: "Del Me", channels: [{ kind: "email", value: `del@${DOMAIN}` }, { kind: "phone", value: "+15550104444" }] }, OP);
    await addMemory(p.party.id, { kind: "fact", content: "Private detail", sourceType: "operator", sourceLabel: "source_fact" }, OP);
    expect(await purgeParty(p.party.id, "dsar_delete", OP)).toEqual({ purged: true, crmExternalId: null });
    expect(await getPartyDetail(p.party.id)).toBeNull();
    expect(await getDb().selectFrom("relationship_memories").select("id").where("counterparty_id", "=", p.party.id).execute()).toEqual([]);
    expect(await isSuppressed("email", `del@${DOMAIN}`)).toBe(true);
    expect(await isSuppressed("phone", "+15550104444")).toBe(true);
    expect(await events(p.party.id)).toContain("purged");
    // The audit chain keeps ids only.
    const audit = await getDb().selectFrom("audit_events").selectAll().where("entity_id", "=", p.party.id).execute();
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain("Private detail");
    expect(JSON.stringify(audit)).not.toContain(`del@${DOMAIN}`);
  });

  describe("Pipedrive copy (stubbed API)", () => {
    const realFetch = globalThis.fetch;
    const saved = { ...process.env };
    const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
    const crm = new CrmService();
    let dealCandidate = "";
    let personId = "";

    beforeAll(async () => {
      Object.assign(process.env, { PIPEDRIVE_COMPANY_DOMAIN: "acme", PIPEDRIVE_API_TOKEN: "tok", PIPEDRIVE_WEBHOOK_USER: "pd", PIPEDRIVE_WEBHOOK_PASSWORD: "secret", PUBLIC_API_BASE_URL: "https://api.example.com" });
      resetConfig();
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        calls.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : null });
        // A person id equal to the deal id: the link table must keep them apart.
        const data = path === "/api/v2/deals" ? { id: Number(DEAL), status: "open", stage_id: 1, value: 300, currency: "USD" } : path === "/api/v2/persons" ? { id: Number(DEAL) } : path === "/api/v2/organizations" ? { id: 51 } : { id: Number(/\/(\d+)$/.exec(path)?.[1] ?? 1) };
        return { ok: true, status: 200, json: async () => ({ success: true, data }) } as Response;
      }) as typeof fetch;
      dealCandidate = await newCandidate();
      const org = await createParty({ type: "organization", displayName: "Bay Liquidators" }, OP);
      const p = await createParty(
        { type: "person", displayName: "Sam Lee", organizationId: org.party.id, channels: [{ kind: "email", value: `sam@${DOMAIN}` }, { kind: "phone", value: "+15550107777" }], link: { subjectType: "intel_candidate", subjectId: dealCandidate, role: "seller" } },
        OP,
      );
      personId = p.party.id;
      partyIds.push(org.party.id, p.party.id);
    });

    afterAll(async () => {
      globalThis.fetch = realFetch;
      process.env = saved;
      resetConfig();
      await getDb().deleteFrom("crm_links").where("subject_id", "=", dealCandidate).execute();
      await getDb().deleteFrom("crm_links").where("subject_type", "=", "counterparty").where("subject_id", "in", partyIds).execute();
    });

    it("copies the deal's contacts on elevation: organization, then person in it, then both on the deal", async () => {
      await crm.elevateCandidate(dealCandidate, OP.id!);
      const org = calls.find((c) => c.method === "POST" && c.path === "/api/v2/organizations")!;
      expect(org.body).toEqual({ name: "Bay Liquidators" });
      const person = calls.find((c) => c.method === "POST" && c.path === "/api/v2/persons")!;
      expect(person.body).toEqual({
        name: "Sam Lee", org_id: 51,
        emails: [{ value: `sam@${DOMAIN}`, primary: true, label: "work" }],
        phones: [{ value: "+15550107777", primary: true, label: "work" }],
      });
      const patch = calls.find((c) => c.method === "PATCH" && c.path === `/api/v2/deals/${DEAL}`)!;
      expect(patch.body).toEqual({ person_id: Number(DEAL), org_id: 51 });
      expect((await getPartyDetail(personId))!.crm).toEqual({ external_id: `person:${DEAL}`, external_url: `https://acme.pipedrive.com/person/${DEAL}` });
    });

    it("updates the existing copy instead of creating another", async () => {
      calls.length = 0;
      await crm.syncParty(personId, OP.id);
      expect(calls.filter((c) => c.method === "POST" && c.path === "/api/v2/persons")).toHaveLength(0);
      expect(calls.some((c) => c.method === "PATCH" && c.path === `/api/v2/persons/${DEAL}`)).toBe(true);
    });

    it("applies deal webhooks to the deal, not to a person with the same id", async () => {
      const ok = `Basic ${Buffer.from("pd:secret").toString("base64")}`;
      const out = await crm.handleWebhook(ok, { meta: { action: "change", entity: "deal", entity_id: Number(DEAL), id: `rel-${RUN}`, timestamp: new Date().toISOString() }, data: { status: "open", stage_id: 4 } });
      expect(out.outcome).toBe("applied");
      const link = await getDb().selectFrom("crm_links").select("external_stage_id").where("subject_id", "=", dealCandidate).executeTakeFirstOrThrow();
      expect(link.external_stage_id).toBe(4);
    });

    it("deletes the Pipedrive copy with the contact", async () => {
      calls.length = 0;
      const { crmExternalId } = await purgeParty(personId, "dsar_delete", OP);
      expect(crmExternalId).toBe(`person:${DEAL}`);
      expect(await crm.deletePartyCopy(crmExternalId)).toBe(true);
      expect(calls).toEqual([{ method: "DELETE", path: `/api/v2/persons/${DEAL}`, body: null }]);
    });
  });
});
