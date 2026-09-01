import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";
import type { EventName } from "@opportunity-os/contracts";

/** A human-gate request for a proposed action (§6.9/§14). */
export interface CreateApprovalInput {
  requestedByAgent: string;
  actionType: string;
  entityType: string;
  entityId: string;
  payloadHash: string;
  humanReadableSummary: string;
  riskSummary: string | null;
  expiresAt: string;
}

export async function createApproval(input: CreateApprovalInput) {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const row = await tx
        .insertInto("approvals")
        .values({
          requested_by_agent: input.requestedByAgent,
          action_type: input.actionType,
          entity_type: input.entityType,
          entity_id: input.entityId,
          payload_hash: input.payloadHash,
          human_readable_summary: input.humanReadableSummary,
          risk_summary: input.riskSummary,
          expires_at: input.expiresAt,
          status: "pending",
          decided_by: null,
          decision: null,
          decision_metadata_json: {},
          decided_at: null,
          notified_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await enqueueEvent(tx, {
        eventName: "approval.requested.v1",
        aggregateType: "approval",
        aggregateId: row.id,
        idempotencyKey: `approval.requested:${row.id}`,
        payload: { approvalId: row.id, actionType: input.actionType, entityType: input.entityType, entityId: input.entityId },
      });

      return row;
    });
}

export async function getApprovalById(id: string) {
  return getDb().selectFrom("approvals").selectAll().where("id", "=", id).executeTakeFirst();
}

/** Pending, undelivered, unexpired approvals for the notifications worker (§14). */
export async function listUndeliveredApprovals(limit = 100) {
  return getDb()
    .selectFrom("approvals")
    .selectAll()
    .where("status", "=", "pending")
    .where("notified_at", "is", null)
    .where("expires_at", ">", new Date().toISOString())
    .orderBy("expires_at", "asc")
    .limit(limit)
    .execute();
}

export async function markApprovalNotified(id: string): Promise<void> {
  await getDb().updateTable("approvals").set({ notified_at: new Date().toISOString() }).where("id", "=", id).execute();
}

export interface DecideApprovalInput {
  status: string;
  decision: string;
  event: EventName;
  decidedBy: string;
  metadata: Record<string, unknown>;
}

/**
 * Record a human decision on a pending approval and emit its lifecycle event in
 * one transaction (§14). The caller is responsible for pre-checking that the
 * approval is still pending and unexpired.
 */
export async function decideApproval(id: string, input: DecideApprovalInput) {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const updated = await tx
        .updateTable("approvals")
        .set({
          status: input.status,
          decision: input.decision,
          decided_by: input.decidedBy,
          decided_at: new Date().toISOString(),
          decision_metadata_json: input.metadata,
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();

      await enqueueEvent(tx, {
        eventName: input.event,
        aggregateType: "approval",
        aggregateId: id,
        idempotencyKey: `${input.event}:${id}`,
        payload: {
          approvalId: id,
          entityType: updated.entity_type,
          entityId: updated.entity_id,
          decision: input.decision,
          decidedBy: input.decidedBy,
        },
      });

      return updated;
    });
}
