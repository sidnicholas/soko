import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { enqueueEvent, getDb } from "@opportunity-os/db";
import type { ApprovalDecision, ApprovalStatus, EventName } from "@opportunity-os/contracts";
import type { Principal } from "../common/current-user";
import { requirePermission } from "../common/current-user";
import type { ApprovalDecisionBody, DecisionKind } from "./approval.dto";

interface DecisionOutcome {
  status: ApprovalStatus;
  decision: ApprovalDecision;
  event: EventName;
}

const DECISIONS: Record<DecisionKind, DecisionOutcome> = {
  approve: { status: "approved", decision: "approve", event: "approval.approved.v1" },
  reject: { status: "rejected", decision: "reject", event: "approval.rejected.v1" },
  // Operator amended the terms then accepted the modified command (§14).
  modify: { status: "modified", decision: "modify", event: "approval.approved.v1" },
};

@Injectable()
export class ApprovalService {
  /** Pending, not-yet-expired approvals awaiting a human decision (§14). */
  listPending() {
    return getDb()
      .selectFrom("approvals")
      .selectAll()
      .where("status", "=", "pending")
      .where("expires_at", ">", new Date().toISOString())
      .orderBy("expires_at", "asc")
      .execute();
  }

  async get(id: string) {
    const approval = await getDb()
      .selectFrom("approvals")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!approval) throw new NotFoundException(`Approval ${id} not found`);
    return approval;
  }

  async decide(id: string, kind: DecisionKind, principal: Principal, body: ApprovalDecisionBody) {
    requirePermission(principal, "approval:decide");
    const approval = await this.get(id);

    if (approval.status !== "pending") {
      throw new ConflictException(`Approval already resolved (status '${approval.status}')`);
    }
    if (new Date(approval.expires_at).getTime() < Date.now()) {
      await getDb().updateTable("approvals").set({ status: "expired" }).where("id", "=", id).execute();
      throw new ConflictException("Approval has expired and can no longer be decided");
    }

    const outcome = DECISIONS[kind];
    const decidedAt = new Date().toISOString();

    return getDb().transaction().execute(async (tx) => {
      const updated = await tx
        .updateTable("approvals")
        .set({
          status: outcome.status,
          decision: outcome.decision,
          decided_by: principal.userId,
          decided_at: decidedAt,
          decision_metadata_json: {
            reason: body.reason ?? null,
            modifications: body.modifications ?? null,
            ...(body.metadata ?? {}),
          },
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();

      await enqueueEvent(tx, {
        eventName: outcome.event,
        aggregateType: "approval",
        aggregateId: id,
        idempotencyKey: `${outcome.event}:${id}`,
        payload: {
          approvalId: id,
          entityType: approval.entity_type,
          entityId: approval.entity_id,
          decision: outcome.decision,
          decidedBy: principal.userId,
        },
      });

      return updated;
    });
  }
}
