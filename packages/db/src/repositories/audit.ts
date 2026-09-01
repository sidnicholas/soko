import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { GENESIS_HASH, hashEvent, type AuditEventDraft } from "@opportunity-os/audit";
import type { Database } from "../schema";

/** Actor + action to record on the append-only, hash-chained audit log (§21). */
export interface AppendAuditInput {
  actorType: "user" | "operator" | "agent" | "service" | "system";
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  inputHash?: string | null;
  outputHash?: string | null;
  policyVersion?: string | null;
  confidence?: number | null;
}

/** Advisory-lock key serializing audit appends so the chain head cannot race. */
const AUDIT_LOCK_KEY = 4242;

/**
 * Append one hash-chained audit event within the caller's transaction (§21):
 * lock, read the current head, link the new event, insert. id/created_at are
 * generated in-app so they are part of the hashed payload and reproducible by
 * verifyChain.
 */
export async function appendAuditEvent(tx: Transaction<Database>, input: AppendAuditInput) {
  await sql`select pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`.execute(tx);

  const head = await tx
    .selectFrom("audit_events")
    .select("event_hash")
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  const previousHash = head?.event_hash ?? GENESIS_HASH;

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const draft: AuditEventDraft = {
    id,
    actor_type: input.actorType,
    actor_id: input.actorId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    input_hash: input.inputHash ?? null,
    output_hash: input.outputHash ?? null,
    policy_version: input.policyVersion ?? null,
    model_provider: null,
    model: null,
    model_version: null,
    confidence: input.confidence ?? null,
    created_at: createdAt,
  };
  const eventHash = hashEvent(previousHash, draft);

  return tx
    .insertInto("audit_events")
    .values({
      id,
      actor_type: draft.actor_type,
      actor_id: draft.actor_id,
      action: draft.action,
      entity_type: draft.entity_type,
      entity_id: draft.entity_id,
      input_hash: draft.input_hash,
      output_hash: draft.output_hash,
      policy_version: draft.policy_version,
      model_provider: draft.model_provider,
      model: draft.model,
      model_version: draft.model_version,
      confidence: draft.confidence,
      previous_event_hash: previousHash === GENESIS_HASH ? null : previousHash,
      event_hash: eventHash,
      created_at: createdAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
