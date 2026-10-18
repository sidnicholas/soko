import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  closeDb,
  createDraft,
  createParty,
  getDb,
  insertIntelLead,
  listClosedCandidates,
  listFollowUps,
  listIntelQueue,
  logTouch,
  markOutboundSent,
  recordInbound,
  snoozeCandidate,
  updateIntelCandidateStatus,
  upsertIntelCandidate,
  type Actor,
} from "@opportunity-os/db";

/**
 * ADR-047 against a live Postgres: a contacted candidate leaves the Action
 * Queue for Follow-ups, ages on its cadence, logs touches by hand and from
 * outreach (email sent, reply filed), can be snoozed, and lands in the
 * closed archive when lost.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);
const OP: Actor = { type: "user", id: randomUUID() };
const DAY = 86_400_000;

async function candidate(tag: string) {
  const runId = (await getDb().insertInto("intel_runs").values({ notes: "{}" }).returning("id").executeTakeFirstOrThrow()).id;
  const leadId = await insertIntelLead({
    runId, kind: "supply", title: `Drills ${tag} ${RUN}`, summary: "s", url: `https://fu-${RUN}.example.com/${tag}`, urlHash: `fu-${RUN}-${tag}`, hostname: `fu-${RUN}.example.com`, query: "q", searchProvider: "stub",
    publishedAt: null, ageText: null, item: null, category: null, quantity: null, location: null, deadline: null, priceMinor: null, currency: null, urgency: "high", credibility: 0.9, contact: null, facts: [], oppositeQueries: [],
  });
  return (await upsertIntelCandidate({
    runId, leadId: leadId!, counterUrl: null, counterSummary: null, serviceKey: null, matchKind: "supply_to_demand", title: `Flip drills ${tag} ${RUN}`, matchRationale: "r", verificationStatus: "verified", freshness: 1,
    economics: {}, monetization: {}, regulatoryFlags: [], fraudFlags: [], contact: null, evLowUsd: 100, evHighUsd: 200, confidence: "high", score: 90, explanation: {}, outreach: {}, bucket: "act_now", rejectReason: null,
  }))!;
}

describe.skipIf(!HAS_DB)("follow-ups (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("moves a contacted candidate out of the queue and ages it", async () => {
    const id = await candidate("a");
    expect((await listIntelQueue()).open.some((c) => c.id === id)).toBe(true);

    await updateIntelCandidateStatus(id, { status: "contacted", reason: null, realizedUsd: null }, OP);
    expect((await listIntelQueue()).open.some((c) => c.id === id)).toBe(false);
    let f = (await listFollowUps()).find((i) => i.id === id)!;
    expect(f.plan).toMatchObject({ stage: "upcoming", step: 2, action: "Follow-up 1 of 3" });
    expect(f.touches.map((t) => t.kind)).toEqual(["contacted"]);

    // Two days later the first follow-up is due.
    f = (await listFollowUps(new Date(Date.now() + 2 * DAY))).find((i) => i.id === id)!;
    expect(f.plan.stage).toBe("due");

    expect(await logTouch({ candidateId: id, kind: "follow_up", channel: "phone", note: "Left a voicemail" }, OP)).toBe(true);
    f = (await listFollowUps()).find((i) => i.id === id)!;
    expect(f.plan).toMatchObject({ outboundTouches: 2, action: "Follow-up 2 of 3" });
    expect(f.touches[0]).toMatchObject({ kind: "follow_up", channel: "phone", note: "Left a voicemail" });

    const until = new Date(Date.now() + 5 * DAY).toISOString();
    expect(await snoozeCandidate(id, until)).toBe(true);
    f = (await listFollowUps(new Date(Date.now() + 4 * DAY))).find((i) => i.id === id)!;
    expect(f.plan).toMatchObject({ stage: "upcoming", snoozed: true });

    await updateIntelCandidateStatus(id, { status: "lost", reason: "no_response", realizedUsd: null, note: "Never answered" }, OP);
    expect((await listFollowUps()).some((i) => i.id === id)).toBe(false);
    const closed = (await listClosedCandidates({ status: "lost" })).find((c) => c.id === id)!;
    expect(closed).toMatchObject({ outcome_reason: "no_response", outcome_note: "Never answered", outbound_touches: 2 });
    const row = await getDb().selectFrom("intel_candidates").select(["status_changed_at", "snoozed_until"]).where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.snoozed_until).toBeNull();
    expect(row.status_changed_at).not.toBeNull();

    // Reopening puts it back in the queue.
    await updateIntelCandidateStatus(id, { status: "open", reason: null, realizedUsd: null }, OP);
    expect((await listIntelQueue()).open.some((c) => c.id === id)).toBe(true);
  });

  it("logs emails about the candidate and replies to them as touches", async () => {
    const id = await candidate("b");
    const address = `sam-${RUN}@shop.example.com`;
    const party = await createParty({ type: "person", displayName: `Sam ${RUN}`, channels: [{ kind: "email", value: address }] }, OP);
    const d = await createDraft({ partyId: party.party.id, toAddress: address, subject: "Drills", body: "Still for sale?", subjectType: "intel_candidate", subjectId: id }, OP);
    // Stand in for approve + claim: the message is being sent.
    await getDb().updateTable("conversation_messages").set({ status: "sending", rfc_message_id: `<out-${RUN}@out.example.com>` }).where("id", "=", d.messageId).execute();
    await markOutboundSent(d.messageId);
    await markOutboundSent(d.messageId);

    let f = (await listFollowUps()).find((i) => i.id === id)!;
    expect(f.user_status).toBe("contacted");
    expect(f.touches).toHaveLength(1);
    expect(f.touches[0]).toMatchObject({ kind: "contacted", channel: "email", source: "outreach" });

    await recordInbound({ rfcMessageId: `<in-${RUN}@shop.example.com>`, references: [`<out-${RUN}@out.example.com>`], inReplyTo: `<out-${RUN}@out.example.com>`, from: address, to: null, subject: "Re: Drills", text: "Yes, still here", classification: "reply", injection: false, receivedAt: new Date().toISOString() });
    f = (await listFollowUps()).find((i) => i.id === id)!;
    expect(f.user_status).toBe("responded");
    expect(f.plan.action).toBe("Next step");
    expect(f.touches.map((t) => t.kind)).toEqual(["responded", "contacted"]);
  });
});
