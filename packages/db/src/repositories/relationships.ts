import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { normalizeChannel, suppressionHash, consentInForce, nextFreshnessCheck, ARCHIVE_AFTER_DAYS, type ChannelKind, type ConsentPurpose } from "@opportunity-os/relationship";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";
import type { Database } from "../schema";
import { appendAuditEvent, type AppendAuditInput } from "./audit";

/**
 * Relationships: contacts, channels, consent and memory (migration 0030, PRD
 * v2 FR-06, ADR-041). Opportunity OS is the system of record for contacts;
 * Pipedrive holds copies through crm_links. Every change commits with an
 * audit event and relationship.memory_updated.v1 (no personal data in either:
 * ids and the kind of change only). Consent is append-only; a memory
 * correction supersedes the old row; a purge keeps only hashed opt-outs.
 */

export type PartyType = "person" | "organization";
export type PartyStatus = "active" | "archived";
export type ChannelStatus = "active" | "invalid" | "bounced";
export type ChannelSourceLabel = "source_fact" | "inference" | "unknown";
export type ConsentChannel = "email" | "phone" | "sms" | "whatsapp" | "any";
export type ConsentStatusValue = "granted" | "denied" | "opted_out";
export type ConsentBasis = "explicit" | "public_business_contact" | "existing_relationship" | "none";
export type MemoryKind = "fact" | "preference" | "commitment" | "objection" | "red_flag" | "buying_cycle" | "outcome" | "note";
export type MemorySource = "lead" | "candidate" | "operator" | "conversation" | "call" | "crm";
export type MemoryLabel = "source_fact" | "inference" | "estimate" | "unknown";
export type LinkSubject = "intel_lead" | "intel_candidate" | "opportunity" | "offnetwork_match";
export type LinkRole = "buyer" | "seller" | "provider" | "decision_maker" | "other";
export type RelationshipChange = "party" | "channel" | "consent" | "memory" | "link" | "archived" | "restored" | "freshness" | "purged";

export interface Actor {
  type: AppendAuditInput["actorType"];
  id: string | null;
}

export interface Party {
  id: string;
  type: PartyType;
  display_name: string;
  organization_id: string | null;
  organization_name: string | null;
  role_title: string | null;
  website: string | null;
  location: string | null;
  source_type: string | null;
  source_url: string | null;
  status: PartyStatus;
  last_activity_at: string;
  archived_at: string | null;
  freshness_checked_at: string | null;
  freshness_due_at: string | null;
  created_at: string;
}

export interface Channel {
  id: string;
  counterparty_id: string;
  kind: ChannelKind;
  value: string;
  normalized_value: string;
  label: string | null;
  is_primary: boolean;
  status: ChannelStatus;
  source_label: ChannelSourceLabel;
  source_url: string | null;
  verified_at: string | null;
  created_at: string;
}

export interface Consent {
  id: string;
  counterparty_id: string;
  channel_kind: ConsentChannel;
  purpose: ConsentPurpose;
  status: ConsentStatusValue;
  basis: ConsentBasis;
  evidence: string | null;
  recorded_by: string | null;
  recorded_at: string;
  expires_at: string | null;
}

export interface Memory {
  id: string;
  counterparty_id: string;
  kind: MemoryKind;
  content: string;
  source_type: MemorySource;
  source_ref: string | null;
  source_label: MemoryLabel;
  confidence: number;
  access: "internal" | "restricted";
  observed_at: string | null;
  expires_at: string | null;
  status: "active" | "superseded" | "deleted";
  superseded_by: string | null;
  created_at: string;
}

export interface PartyLink {
  id: string;
  counterparty_id: string;
  subject_type: LinkSubject;
  subject_id: string;
  role: LinkRole;
  created_at: string;
}

export interface PartyDetail {
  party: Party;
  channels: Channel[];
  consents: Consent[];
  /** The consent in force per channel kind for outreach, as the outreach gate will read it. */
  outreach: { channel_kind: ConsentChannel; status: ConsentStatusValue | "none"; basis: ConsentBasis | null }[];
  memories: Memory[];
  links: PartyLink[];
  members: Pick<Party, "id" | "display_name" | "role_title" | "status">[];
  crm: { external_id: string | null; external_url: string | null } | null;
}

export class RelationshipError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_channel" | "invalid_organization" | "memory_not_active",
    message: string,
  ) {
    super(message);
  }
}

const PARTY_COLUMNS = [
  "p.id",
  "p.type",
  sql<string>`coalesce(p.display_name, p.normalized_name)`.as("display_name"),
  "p.organization_id",
  "o.display_name as organization_name",
  "p.role_title",
  "p.website",
  "p.location",
  "p.source_type",
  "p.source_url",
  "p.status",
  sql<string>`p.last_activity_at::text`.as("last_activity_at"),
  sql<string | null>`p.archived_at::text`.as("archived_at"),
  sql<string | null>`p.freshness_checked_at::text`.as("freshness_checked_at"),
  sql<string | null>`p.freshness_due_at::text`.as("freshness_due_at"),
  sql<string>`p.created_at::text`.as("created_at"),
] as const;

const CHANNEL_COLUMNS = [
  "id",
  "counterparty_id",
  "kind",
  "value",
  "normalized_value",
  "label",
  "is_primary",
  "status",
  "source_label",
  "source_url",
  sql<string | null>`verified_at::text`.as("verified_at"),
  sql<string>`created_at::text`.as("created_at"),
] as const;

const CONSENT_COLUMNS = [
  "id",
  "counterparty_id",
  "channel_kind",
  "purpose",
  "status",
  "basis",
  "evidence",
  "recorded_by",
  sql<string>`recorded_at::text`.as("recorded_at"),
  sql<string | null>`expires_at::text`.as("expires_at"),
] as const;

const MEMORY_COLUMNS = [
  "id",
  "counterparty_id",
  "kind",
  "content",
  "source_type",
  "source_ref",
  "source_label",
  sql<number>`confidence::float`.as("confidence"),
  "access",
  sql<string | null>`observed_at::text`.as("observed_at"),
  sql<string | null>`expires_at::text`.as("expires_at"),
  "status",
  "superseded_by",
  sql<string>`created_at::text`.as("created_at"),
] as const;

const LINK_COLUMNS = ["id", "counterparty_id", "subject_type", "subject_id", "role", sql<string>`created_at::text`.as("created_at")] as const;

const cast = <T>(r: unknown) => r as T;
const normalizeName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/** Audit event plus relationship.memory_updated.v1 for one change, in the caller's transaction. */
async function recordChange(tx: Transaction<Database>, partyId: string, change: RelationshipChange, actor: Actor, detail: Record<string, unknown> = {}) {
  await appendAuditEvent(tx, { actorType: actor.type, actorId: actor.id, action: `relationship.${change}`, entityType: "counterparty", entityId: partyId });
  await enqueueEvent(tx, {
    eventName: "relationship.memory_updated.v1",
    aggregateType: "counterparty",
    aggregateId: partyId,
    idempotencyKey: `relationship.memory_updated:${partyId}:${change}:${randomUUID()}`,
    payload: { counterpartyId: partyId, change, ...detail },
  });
}

/** Operator or system activity on a party: it counts as recent, and an archived party comes back. */
async function touch(tx: Transaction<Database>, partyId: string): Promise<void> {
  await tx
    .updateTable("counterparties")
    .set({ last_activity_at: sql`now()`, updated_at: sql`now()`, status: "active", archived_at: null, freshness_due_at: null })
    .where("id", "=", partyId)
    .execute();
}

async function requireParty(tx: Transaction<Database>, partyId: string) {
  const row = await tx.selectFrom("counterparties").select(["id", "type", "status"]).where("id", "=", partyId).forUpdate().executeTakeFirst();
  if (!row) throw new RelationshipError("not_found", "Contact not found");
  return row;
}

async function assertOrganization(tx: Transaction<Database>, organizationId: string | null | undefined) {
  if (!organizationId) return;
  const org = await tx.selectFrom("counterparties").select("type").where("id", "=", organizationId).executeTakeFirst();
  if (org?.type !== "organization") throw new RelationshipError("invalid_organization", "organization_id must reference an organization");
}

export interface ChannelInput {
  kind: ChannelKind;
  value: string;
  label?: string | null;
  isPrimary?: boolean;
  sourceLabel?: ChannelSourceLabel;
  sourceUrl?: string | null;
}

/**
 * Inserts a channel (the same normalized value on the same party is one
 * channel). A channel whose hash is suppressed (opted out before a purge)
 * re-enters with an opt-out recorded, so it is never contacted again.
 */
async function insertChannel(tx: Transaction<Database>, partyId: string, input: ChannelInput, actor: Actor): Promise<Channel> {
  const normalized = normalizeChannel(input.kind, input.value);
  if (!normalized) throw new RelationshipError("invalid_channel", `Not a valid ${input.kind}`);
  if (input.isPrimary) await tx.updateTable("contact_channels").set({ is_primary: false }).where("counterparty_id", "=", partyId).where("kind", "=", input.kind).execute();
  const row = await tx
    .insertInto("contact_channels")
    .values({
      counterparty_id: partyId,
      kind: input.kind,
      value: input.value.trim().slice(0, 500),
      normalized_value: normalized,
      label: input.label?.trim().slice(0, 100) || null,
      is_primary: input.isPrimary ?? false,
      source_label: input.sourceLabel ?? "source_fact",
      source_url: input.sourceUrl ?? null,
    })
    .onConflict((oc) =>
      oc.columns(["counterparty_id", "kind", "normalized_value"]).doUpdateSet({ label: sql`coalesce(excluded.label, contact_channels.label)`, is_primary: sql`contact_channels.is_primary or excluded.is_primary` }),
    )
    .returning(CHANNEL_COLUMNS)
    .executeTakeFirstOrThrow();
  const consentKind = input.kind === "email" ? "email" : input.kind === "phone" ? "phone" : null;
  if (consentKind) {
    const suppressed = await tx.selectFrom("contact_suppressions").select("reason").where("identifier_hash", "=", suppressionHash(input.kind, normalized)).executeTakeFirst();
    if (suppressed) {
      await tx
        .insertInto("contact_consents")
        .values({ counterparty_id: partyId, channel_kind: consentKind, purpose: "outreach", status: "opted_out", basis: "none", evidence: `Suppressed identifier (${suppressed.reason})`, recorded_by: actor.id })
        .execute();
    }
  }
  return cast<Channel>(row);
}

export interface NewParty {
  type: PartyType;
  displayName: string;
  organizationId?: string | null;
  roleTitle?: string | null;
  website?: string | null;
  location?: string | null;
  sourceType?: string | null;
  sourceUrl?: string | null;
  channels?: ChannelInput[];
  link?: { subjectType: LinkSubject; subjectId: string; role: LinkRole };
}

export async function createParty(input: NewParty, actor: Actor): Promise<PartyDetail> {
  const id = await getDb()
    .transaction()
    .execute(async (tx) => {
      await assertOrganization(tx, input.organizationId);
      const name = input.displayName.trim().slice(0, 200);
      const row = await tx
        .insertInto("counterparties")
        .values({
          type: input.type,
          normalized_name: normalizeName(name),
          display_name: name,
          source_identities_json: JSON.stringify([]),
          trust_score: 0,
          verification_level: "none",
          risk_flags_json: JSON.stringify([]),
          transaction_stats_json: JSON.stringify({}),
          organization_id: input.type === "person" ? (input.organizationId ?? null) : null,
          role_title: input.roleTitle?.trim() || null,
          website: input.website?.trim() || null,
          location: input.location?.trim() || null,
          source_type: input.sourceType ?? "operator",
          source_url: input.sourceUrl ?? null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      for (const c of input.channels ?? []) await insertChannel(tx, row.id, c, actor);
      if (input.website && !(input.channels ?? []).some((c) => c.kind === "website") && normalizeChannel("website", input.website)) {
        await insertChannel(tx, row.id, { kind: "website", value: input.website, sourceUrl: input.sourceUrl ?? null }, actor);
      }
      if (input.link) await insertLink(tx, row.id, input.link);
      await recordChange(tx, row.id, "party", actor, { action: "created", type: input.type });
      return row.id;
    });
  return (await getPartyDetail(id))!;
}

export interface PartyPatch {
  displayName?: string;
  organizationId?: string | null;
  roleTitle?: string | null;
  website?: string | null;
  location?: string | null;
}

export async function updateParty(partyId: string, patch: PartyPatch, actor: Actor): Promise<PartyDetail> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      const party = await requireParty(tx, partyId);
      if (patch.organizationId !== undefined) {
        if (patch.organizationId === partyId) throw new RelationshipError("invalid_organization", "A party cannot belong to itself");
        await assertOrganization(tx, patch.organizationId);
      }
      const name = patch.displayName?.trim().slice(0, 200);
      await tx
        .updateTable("counterparties")
        .set({
          ...(name ? { display_name: name, normalized_name: normalizeName(name) } : {}),
          ...(patch.organizationId !== undefined && party.type === "person" ? { organization_id: patch.organizationId } : {}),
          ...(patch.roleTitle !== undefined ? { role_title: patch.roleTitle?.trim() || null } : {}),
          ...(patch.website !== undefined ? { website: patch.website?.trim() || null } : {}),
          ...(patch.location !== undefined ? { location: patch.location?.trim() || null } : {}),
        })
        .where("id", "=", partyId)
        .execute();
      await touch(tx, partyId);
      await recordChange(tx, partyId, "party", actor, { action: "updated", fields: Object.keys(patch) });
    });
  return (await getPartyDetail(partyId))!;
}

export async function addChannel(partyId: string, input: ChannelInput, actor: Actor): Promise<Channel> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      await requireParty(tx, partyId);
      const channel = await insertChannel(tx, partyId, input, actor);
      await touch(tx, partyId);
      await recordChange(tx, partyId, "channel", actor, { action: "added", channelId: channel.id, kind: channel.kind });
      return channel;
    });
}

export async function setChannelStatus(partyId: string, channelId: string, status: ChannelStatus, actor: Actor): Promise<Channel> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      await requireParty(tx, partyId);
      const row = await tx
        .updateTable("contact_channels")
        .set({ status, ...(status === "active" ? { verified_at: sql`now()` } : {}) })
        .where("id", "=", channelId)
        .where("counterparty_id", "=", partyId)
        .returning(CHANNEL_COLUMNS)
        .executeTakeFirst();
      if (!row) throw new RelationshipError("not_found", "Channel not found");
      await touch(tx, partyId);
      await recordChange(tx, partyId, "channel", actor, { action: "status", channelId, status });
      return cast<Channel>(row);
    });
}

export async function removeChannel(partyId: string, channelId: string, actor: Actor): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      await requireParty(tx, partyId);
      const removed = await tx.deleteFrom("contact_channels").where("id", "=", channelId).where("counterparty_id", "=", partyId).returning(["kind", "normalized_value"]).executeTakeFirst();
      if (!removed) throw new RelationshipError("not_found", "Channel not found");
      // A removed channel that had opted out stays suppressed.
      if (await hasOptOut(tx, partyId, removed.kind)) await suppress(tx, removed.kind as ChannelKind, removed.normalized_value, "opted_out");
      await touch(tx, partyId);
      await recordChange(tx, partyId, "channel", actor, { action: "removed", channelId });
    });
}

export interface ConsentInput {
  channelKind: ConsentChannel;
  purpose: ConsentPurpose;
  status: ConsentStatusValue;
  basis: ConsentBasis;
  evidence?: string | null;
  expiresAt?: string | null;
}

/** Appends a consent record; the history is never edited (PRD FR-06, FR-07). */
export async function recordConsent(partyId: string, input: ConsentInput, actor: Actor): Promise<Consent> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      await requireParty(tx, partyId);
      const row = await tx
        .insertInto("contact_consents")
        .values({
          counterparty_id: partyId,
          channel_kind: input.channelKind,
          purpose: input.purpose,
          status: input.status,
          basis: input.basis,
          evidence: input.evidence?.trim().slice(0, 1000) || null,
          recorded_by: actor.id,
          expires_at: input.expiresAt ?? null,
        })
        .returning(CONSENT_COLUMNS)
        .executeTakeFirstOrThrow();
      await touch(tx, partyId);
      await recordChange(tx, partyId, "consent", actor, { consentId: row.id, channelKind: input.channelKind, purpose: input.purpose, status: input.status });
      return cast<Consent>(row);
    });
}

export interface MemoryInput {
  kind: MemoryKind;
  content: string;
  sourceType: MemorySource;
  sourceRef?: string | null;
  sourceLabel: MemoryLabel;
  confidence?: number;
  access?: "internal" | "restricted";
  observedAt?: string | null;
  expiresAt?: string | null;
}

async function insertMemory(tx: Transaction<Database>, partyId: string, input: MemoryInput, actor: Actor) {
  return tx
    .insertInto("relationship_memories")
    .values({
      counterparty_id: partyId,
      kind: input.kind,
      content: input.content.trim().slice(0, 4000),
      source_type: input.sourceType,
      source_ref: input.sourceRef ?? null,
      source_label: input.sourceLabel,
      confidence: Math.min(1, Math.max(0, input.confidence ?? 1)).toFixed(3),
      access: input.access ?? "internal",
      observed_at: input.observedAt ?? null,
      expires_at: input.expiresAt ?? null,
      created_by: actor.id,
    })
    .returning(MEMORY_COLUMNS)
    .executeTakeFirstOrThrow();
}

export async function addMemory(partyId: string, input: MemoryInput, actor: Actor): Promise<Memory> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      await requireParty(tx, partyId);
      const row = await insertMemory(tx, partyId, input, actor);
      await touch(tx, partyId);
      await recordChange(tx, partyId, "memory", actor, { action: "added", memoryId: row.id, kind: input.kind });
      return cast<Memory>(row);
    });
}

/** A correction is a new memory; the old one is kept as superseded (correction history, PRD FR-06). */
export async function correctMemory(partyId: string, memoryId: string, input: MemoryInput, actor: Actor): Promise<Memory> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      await requireParty(tx, partyId);
      const old = await tx.selectFrom("relationship_memories").select(["status"]).where("id", "=", memoryId).where("counterparty_id", "=", partyId).forUpdate().executeTakeFirst();
      if (!old) throw new RelationshipError("not_found", "Memory not found");
      if (old.status !== "active") throw new RelationshipError("memory_not_active", "Only an active memory can be corrected");
      const row = await insertMemory(tx, partyId, input, actor);
      await tx.updateTable("relationship_memories").set({ status: "superseded", superseded_by: row.id }).where("id", "=", memoryId).execute();
      await touch(tx, partyId);
      await recordChange(tx, partyId, "memory", actor, { action: "corrected", memoryId: row.id, supersedes: memoryId });
      return cast<Memory>(row);
    });
}

/** Deletion removes the content (only the fact that a memory existed and was deleted remains), and that of any version it superseded. */
export async function deleteMemory(partyId: string, memoryId: string, actor: Actor): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      await requireParty(tx, partyId);
      const ids = await sql<{ id: string }>`
        with recursive chain as (
          select id from relationship_memories where id = ${memoryId} and counterparty_id = ${partyId}
          union
          select m.id from relationship_memories m join chain c on m.superseded_by = c.id
        ) select id from chain`.execute(tx);
      if (ids.rows.length === 0) throw new RelationshipError("not_found", "Memory not found");
      await tx
        .updateTable("relationship_memories")
        .set({ status: "deleted", content: "", source_ref: null })
        .where(
          "id",
          "in",
          ids.rows.map((r) => r.id),
        )
        .execute();
      await touch(tx, partyId);
      await recordChange(tx, partyId, "memory", actor, { action: "deleted", memoryId });
    });
}

async function insertLink(tx: Transaction<Database>, partyId: string, link: { subjectType: LinkSubject; subjectId: string; role: LinkRole }) {
  return tx
    .insertInto("counterparty_links")
    .values({ counterparty_id: partyId, subject_type: link.subjectType, subject_id: link.subjectId, role: link.role })
    .onConflict((oc) => oc.columns(["counterparty_id", "subject_type", "subject_id", "role"]).doNothing())
    .execute();
}

export async function linkParty(partyId: string, link: { subjectType: LinkSubject; subjectId: string; role: LinkRole }, actor: Actor): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      await requireParty(tx, partyId);
      await insertLink(tx, partyId, link);
      await touch(tx, partyId);
      await recordChange(tx, partyId, "link", actor, { action: "linked", subjectType: link.subjectType, subjectId: link.subjectId, role: link.role });
    });
}

export async function unlinkParty(partyId: string, linkId: string, actor: Actor): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      await requireParty(tx, partyId);
      const removed = await tx.deleteFrom("counterparty_links").where("id", "=", linkId).where("counterparty_id", "=", partyId).returning("id").executeTakeFirst();
      if (!removed) throw new RelationshipError("not_found", "Link not found");
      await recordChange(tx, partyId, "link", actor, { action: "unlinked", linkId });
    });
}

export async function listParties(opts: { status?: PartyStatus; type?: PartyType; q?: string; limit?: number } = {}): Promise<(Party & { channel_count: number; memory_count: number })[]> {
  let q = getDb()
    .selectFrom("counterparties as p")
    .leftJoin("counterparties as o", "o.id", "p.organization_id")
    .select([
      ...PARTY_COLUMNS,
      sql<number>`(select count(*)::int from contact_channels c where c.counterparty_id = p.id)`.as("channel_count"),
      sql<number>`(select count(*)::int from relationship_memories m where m.counterparty_id = p.id and m.status = 'active')`.as("memory_count"),
    ])
    .where("p.status", "=", opts.status ?? "active");
  if (opts.type) q = q.where("p.type", "=", opts.type);
  if (opts.q?.trim()) {
    const like = `%${opts.q.trim().toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    q = q.where((eb) =>
      eb.or([
        eb("p.normalized_name", "like", like),
        eb.exists(eb.selectFrom("contact_channels as c").select("c.id").whereRef("c.counterparty_id", "=", "p.id").where("c.normalized_value", "like", like)),
      ]),
    );
  }
  const rows = await q
    .orderBy("p.last_activity_at", "desc")
    .limit(Math.min(opts.limit ?? 100, 500))
    .execute();
  return cast(rows);
}

export async function getPartyDetail(partyId: string): Promise<PartyDetail | null> {
  const db = getDb();
  const party = await db.selectFrom("counterparties as p").leftJoin("counterparties as o", "o.id", "p.organization_id").select(PARTY_COLUMNS).where("p.id", "=", partyId).executeTakeFirst();
  if (!party) return null;
  const [channels, consents, memories, links, members, crm] = await Promise.all([
    db.selectFrom("contact_channels").select(CHANNEL_COLUMNS).where("counterparty_id", "=", partyId).orderBy("is_primary", "desc").orderBy("created_at").execute(),
    db.selectFrom("contact_consents").select(CONSENT_COLUMNS).where("counterparty_id", "=", partyId).orderBy("recorded_at", "desc").execute(),
    db.selectFrom("relationship_memories").select(MEMORY_COLUMNS).where("counterparty_id", "=", partyId).where("status", "=", "active").orderBy("created_at", "desc").execute(),
    db.selectFrom("counterparty_links").select(LINK_COLUMNS).where("counterparty_id", "=", partyId).orderBy("created_at", "desc").execute(),
    db
      .selectFrom("counterparties")
      .select(["id", sql<string>`coalesce(display_name, normalized_name)`.as("display_name"), "role_title", "status"])
      .where("organization_id", "=", partyId)
      .orderBy("normalized_name")
      .execute(),
    db.selectFrom("crm_links").select(["external_id", "external_url"]).where("subject_type", "=", "counterparty").where("subject_id", "=", partyId).executeTakeFirst(),
  ]);
  const consentRows = cast<Consent[]>(consents);
  const outreach = (["email", "phone", "sms", "whatsapp"] as const).map((k) => {
    const c = consentInForce(consentRows, k, "outreach");
    return { channel_kind: k, status: (c?.status as ConsentStatusValue | undefined) ?? ("none" as const), basis: (c?.basis as ConsentBasis | undefined) ?? null };
  });
  return {
    party: cast<Party>(party),
    channels: cast<Channel[]>(channels),
    consents: consentRows,
    outreach,
    memories: cast<Memory[]>(memories),
    links: cast<PartyLink[]>(links),
    members: cast(members),
    crm: crm ?? null,
  };
}

/** The parties linked to a lead, candidate or deal, with their channels. */
export async function listPartiesForSubject(subjectType: LinkSubject, subjectId: string): Promise<(Party & { role: LinkRole; link_id: string; channels: Channel[] })[]> {
  const db = getDb();
  const rows = await db
    .selectFrom("counterparty_links as l")
    .innerJoin("counterparties as p", "p.id", "l.counterparty_id")
    .leftJoin("counterparties as o", "o.id", "p.organization_id")
    .select([...PARTY_COLUMNS, "l.role", "l.id as link_id"])
    .where("l.subject_type", "=", subjectType)
    .where("l.subject_id", "=", subjectId)
    .orderBy("l.created_at")
    .execute();
  if (rows.length === 0) return [];
  const channels = await db
    .selectFrom("contact_channels")
    .select(CHANNEL_COLUMNS)
    .where(
      "counterparty_id",
      "in",
      rows.map((r) => r.id),
    )
    .orderBy("is_primary", "desc")
    .execute();
  return rows.map((r) => ({ ...cast<Party & { role: LinkRole; link_id: string }>(r), channels: cast<Channel[]>(channels.filter((c) => c.counterparty_id === r.id)) }));
}

/** An existing party holding this channel, so the same contact is not entered twice. */
export async function findPartyByChannel(kind: ChannelKind, value: string): Promise<Party | null> {
  const normalized = normalizeChannel(kind, value);
  if (!normalized) return null;
  const row = await getDb()
    .selectFrom("contact_channels as c")
    .innerJoin("counterparties as p", "p.id", "c.counterparty_id")
    .leftJoin("counterparties as o", "o.id", "p.organization_id")
    .select(PARTY_COLUMNS)
    .where("c.kind", "=", kind)
    .where("c.normalized_value", "=", normalized)
    .orderBy("p.last_activity_at", "desc")
    .executeTakeFirst();
  return row ? cast<Party>(row) : null;
}

export async function isSuppressed(kind: ChannelKind, value: string): Promise<boolean> {
  const normalized = normalizeChannel(kind, value);
  if (!normalized) return false;
  const row = await getDb().selectFrom("contact_suppressions").select("identifier_hash").where("identifier_hash", "=", suppressionHash(kind, normalized)).executeTakeFirst();
  return !!row;
}

// ---------------------------------------------------------------------------
// Retention: archive, freshness, purge, DSAR (product owner, 2026-10-16).

/** Archives every active party with no activity for 90 days; its first freshness check is due one interval later. */
export async function archiveInactiveParties(now: Date = new Date()): Promise<string[]> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const rows = await tx
        .updateTable("counterparties")
        .set({ status: "archived", archived_at: now.toISOString(), freshness_due_at: nextFreshnessCheck(now), updated_at: sql`now()` })
        .where("status", "=", "active")
        .where(sql<boolean>`last_activity_at <= ${now.toISOString()}::timestamptz - make_interval(days => ${ARCHIVE_AFTER_DAYS})`)
        .returning("id")
        .execute();
      for (const r of rows) await recordChange(tx, r.id, "archived", { type: "system", id: null });
      return rows.map((r) => r.id);
    });
}

export async function restoreParty(partyId: string, actor: Actor): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      await requireParty(tx, partyId);
      await touch(tx, partyId);
      await recordChange(tx, partyId, "restored", actor);
    });
}

/** Archived parties whose freshness check is due, with the channels the check can probe. */
export async function listFreshnessDue(limit = 50, now: Date = new Date()): Promise<{ id: string; channels: { kind: string; normalized_value: string }[] }[]> {
  const db = getDb();
  const parties = await db
    .selectFrom("counterparties")
    .select("id")
    .where("status", "=", "archived")
    .where("freshness_due_at", "<=", now.toISOString())
    .orderBy("freshness_due_at")
    .limit(limit)
    .execute();
  if (parties.length === 0) return [];
  const channels = await db
    .selectFrom("contact_channels")
    .select(["counterparty_id", "kind", "normalized_value"])
    .where(
      "counterparty_id",
      "in",
      parties.map((p) => p.id),
    )
    .where("status", "=", "active")
    .execute();
  return parties.map((p) => ({ id: p.id, channels: channels.filter((c) => c.counterparty_id === p.id) }));
}

/** Records a fresh or unverifiable check: the party stays archived and is checked again one interval later. */
export async function recordFreshnessKept(partyId: string, verdict: "fresh" | "unverifiable", now: Date = new Date()): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      const row = await tx
        .updateTable("counterparties")
        .set({ freshness_checked_at: now.toISOString(), freshness_due_at: nextFreshnessCheck(now) })
        .where("id", "=", partyId)
        .where("status", "=", "archived")
        .returning("id")
        .executeTakeFirst();
      if (row) await recordChange(tx, partyId, "freshness", { type: "system", id: null }, { verdict });
    });
}

async function hasOptOut(tx: Transaction<Database>, partyId: string, channelKind: string): Promise<boolean> {
  const kinds = channelKind === "phone" ? ["phone", "sms", "whatsapp", "any"] : [channelKind, "any"];
  const rows = await tx.selectFrom("contact_consents").select(CONSENT_COLUMNS).where("counterparty_id", "=", partyId).where("channel_kind", "in", kinds).execute();
  const records = cast<Consent[]>(rows);
  return (["outreach", "marketing"] as const).some((purpose) => kinds.some((k) => k !== "any" && ["opted_out", "denied"].includes(consentInForce(records, k, purpose)?.status ?? "")));
}

async function suppress(tx: Transaction<Database>, kind: ChannelKind, normalized: string, reason: string) {
  await tx.insertInto("contact_suppressions").values({ identifier_hash: suppressionHash(kind, normalized), kind, reason }).onConflict((oc) => oc.column("identifier_hash").doNothing()).execute();
}

export type PurgeReason = "stale" | "dsar_delete";

/**
 * Deletes a party and everything hanging off it (channels, consents,
 * memories, links; members keep existing without the organization). Kept:
 * a hash of each channel that opted out — of every email and phone channel
 * when the party asked to be deleted — so it is never contacted again; the
 * audit chain (ids only). Returns the Pipedrive copy, which the caller removes.
 */
export async function purgeParty(partyId: string, reason: PurgeReason, actor: Actor): Promise<{ purged: boolean; crmExternalId: string | null }> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const party = await tx.selectFrom("counterparties").select("id").where("id", "=", partyId).forUpdate().executeTakeFirst();
      if (!party) return { purged: false, crmExternalId: null };
      const channels = await tx.selectFrom("contact_channels").select(["kind", "normalized_value"]).where("counterparty_id", "=", partyId).execute();
      for (const c of channels) {
        if (c.kind !== "email" && c.kind !== "phone") continue;
        if (reason === "dsar_delete") await suppress(tx, c.kind, c.normalized_value, "dsar_delete");
        else if (await hasOptOut(tx, partyId, c.kind)) await suppress(tx, c.kind, c.normalized_value, "opted_out");
      }
      const crm = await tx.deleteFrom("crm_links").where("subject_type", "=", "counterparty").where("subject_id", "=", partyId).returning("external_id").executeTakeFirst();
      await tx.deleteFrom("counterparties").where("id", "=", partyId).execute();
      await recordChange(tx, partyId, "purged", actor, { reason });
      return { purged: true, crmExternalId: crm?.external_id ?? null };
    });
}
