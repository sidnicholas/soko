import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { decideApproval, getDb } from "@opportunity-os/db";
import { mintApprovalToken } from "@opportunity-os/auth";
import { getConfig } from "@opportunity-os/config";
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
    const approval = await getDb().selectFrom("approvals").selectAll().where("id", "=", id).executeTakeFirst();
    if (!approval) throw new NotFoundException(`Approval ${id} not found`);
    return approval;
  }

  /**
   * Record a human decision. On approve/modify, mint a signed approval token
   * bound to this approval's action + payload hash — the only thing that can
   * later authorize the gated action (§14/§22). Rejection mints nothing.
   */
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
    const updated = await decideApproval(id, {
      status: outcome.status,
      decision: outcome.decision,
      event: outcome.event,
      decidedBy: principal.userId,
      metadata: {
        reason: body.reason ?? null,
        modifications: body.modifications ?? null,
        ...(body.metadata ?? {}),
      },
    });

    if (outcome.decision === "reject") return { approval: updated };

    const cfg = getConfig();
    const approval_token = mintApprovalToken(cfg.security.approvalTokenSecret, {
      approvalId: id,
      action: updated.action_type,
      entityType: updated.entity_type,
      entityId: updated.entity_id,
      payloadHash: updated.payload_hash,
      expiresAt: new Date(Date.now() + cfg.policy.approvalTimeoutMinutes * 60_000).toISOString(),
    });
    return { approval: updated, approval_token };
  }
}
