import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { closeDb, createDraft, createParty, getBriefing, getDb, insertIntelLead, recordInbound, upsertIntelCandidate, type Actor } from "@opportunity-os/db";
import { resetConfig } from "@opportunity-os/config";
import { briefingCycle, generateBriefing, type Brief } from "@opportunity-os/briefing";
import type { OutgoingMail } from "@opportunity-os/outreach";

/**
 * ADR-046 against a live Postgres: the brief reads the last 24 hours
 * (candidates, outreach, spend), cites every item, is built once per local
 * day after the configured hour, and is emailed when an address is set
 * (mailbox stubbed).
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);
const OP: Actor = { type: "user", id: randomUUID() };

describe.skipIf(!HAS_DB)("daily brief (live postgres)", () => {
  afterAll(async () => {
    for (const k of ["BRIEF_EMAIL_TO", "OUTREACH_EMAIL_ADDRESS", "OUTREACH_EMAIL_PASSWORD", "OUTREACH_POSTAL_ADDRESS", "PUBLIC_API_BASE_URL", "WEB_ORIGINS"]) delete process.env[k];
    resetConfig();
    await closeDb();
  });

  it("summarizes the last 24 hours with a citation on every item", async () => {
    const runId = (await getDb().insertInto("intel_runs").values({ notes: "{}", search_usd: 0.25, llm_usd: 0.5 }).returning("id").executeTakeFirstOrThrow()).id;
    const url = `https://brief-${RUN}.example.com/item`;
    const leadId = await insertIntelLead({
      runId, kind: "supply", title: `Pallets ${RUN}`, summary: "s", url, urlHash: `brief-${RUN}`, hostname: `brief-${RUN}.example.com`, query: "q", searchProvider: "stub",
      publishedAt: null, ageText: null, item: null, category: null, quantity: null, location: null, deadline: null, priceMinor: null, currency: null, urgency: "high", credibility: 0.9, contact: null, facts: [], oppositeQueries: [],
    });
    const candidateId = await upsertIntelCandidate({
      runId, leadId: leadId!, counterUrl: null, counterSummary: null, serviceKey: null, matchKind: "supply_to_demand", title: `Broker pallets ${RUN}`, matchRationale: "r", verificationStatus: "verified", freshness: 1,
      economics: {}, monetization: {}, regulatoryFlags: [], fraudFlags: [], contact: null, evLowUsd: 300, evHighUsd: 900, confidence: "high", score: 99.9, explanation: {}, outreach: {}, bucket: "act_now", rejectReason: null,
    });
    const party = await createParty({ type: "person", displayName: `Jo ${RUN}`, channels: [{ kind: "email", value: `jo-${RUN}@acme.example.com` }] }, OP);
    const d = await createDraft({ partyId: party.party.id, toAddress: `jo-${RUN}@acme.example.com`, subject: "Pallets", body: "Hi" }, OP);
    await recordInbound({ rfcMessageId: `<in-${RUN}@acme.example.com>`, references: [], inReplyTo: null, from: `jo-${RUN}@acme.example.com`, to: null, subject: "Re: Pallets", text: "Interested", classification: "reply", injection: false, receivedAt: new Date().toISOString() });

    const row = (await generateBriefing({ replace: true }))!;
    const b = row.content as Brief;
    expect(row.headline).toBe(b.headline);
    const candidates = b.sections.find((s) => s.key === "candidates")!;
    const mine = candidates.items.find((i) => i.text === `Broker pallets ${RUN}`)!;
    expect(mine.citations.map((c) => c.href)).toEqual(["/queue", url]);
    const outreach = b.sections.find((s) => s.key === "outreach")!;
    expect(outreach.items.find((i) => i.text === `Reply from Jo ${RUN}`)!.citations[0]!.href).toBe(`/outreach/${d.conversationId}`);
    for (const s of b.sections) for (const i of s.items) expect(i.citations.length).toBeGreaterThan(0);
    const spend = b.sections.find((s) => s.key === "spend")!;
    expect(spend.summary).toMatch(/^\$\d/);
    expect(candidateId).toBeTruthy();

    const ev = await getDb().selectFrom("outbox").select("payload").where("event_name", "=", "briefing.ready.v1").where("aggregate_id", "=", row.id).execute();
    expect(ev.length).toBeGreaterThan(0);
  });

  it("builds once per local day after the hour and emails it", async () => {
    Object.assign(process.env, {
      BRIEF_EMAIL_TO: "ops@example.com",
      OUTREACH_EMAIL_ADDRESS: `brief@out-${RUN}.example.com`,
      OUTREACH_EMAIL_PASSWORD: "x",
      OUTREACH_POSTAL_ADDRESS: "1 Main St",
      PUBLIC_API_BASE_URL: "https://api.example.com",
      WEB_ORIGINS: "https://app.example.com",
    });
    resetConfig();
    const sent: OutgoingMail[] = [];
    const sender = { send: async (m: OutgoingMail) => void sent.push(m) };
    // A far-off day so no other run has a brief for it: 6:00 and 8:00 in Detroit (EST).
    const day = 2031 + (parseInt(RUN.slice(0, 4), 16) % 60);
    const early = new Date(`${day}-03-04T11:00:00Z`);
    const late = new Date(`${day}-03-04T13:00:00Z`);
    expect(await briefingCycle({ now: early, sender })).toBeNull();
    const row = await briefingCycle({ now: late, sender });
    expect(row?.brief_date).toBe(`${day}-03-04`);
    expect(await briefingCycle({ now: late, sender })).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ops@example.com");
    expect(sent[0]!.subject).toBe(`Daily brief ${day}-03-04: ${row!.headline}`);
    expect(sent[0]!.text).toContain(`Open in Opportunity OS: https://app.example.com/brief?date=${day}-03-04`);
    expect((await getBriefing(`${day}-03-04`))!.delivered_at).not.toBeNull();
  });
});
