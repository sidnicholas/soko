import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createAssetTransferPlan, getAssetTransferPlan, recordAssetTransferResult, setAssetTransferReference } from "@opportunity-os/db";
import { verifyApprovalToken } from "@opportunity-os/auth";
import { hashAssetTransferTerms } from "@opportunity-os/audit";
import { getConfig } from "@opportunity-os/config";
import type { AssetDescriptor } from "@opportunity-os/contracts";
import type { AssetTransferService as RailService } from "@opportunity-os/settlement";
import type { Principal } from "../common/current-user";
import type { CreateAssetTransferPlanBody } from "./asset-transfer.dto";
import { createAssetTransferService } from "./rails";

@Injectable()
export class AssetTransferService {
  private readonly rails: RailService = createAssetTransferService(getConfig());

  /** Create the plan row, then prepare the rail's reference immediately (nothing to phase-capture like Stripe/settlement). */
  async create(body: CreateAssetTransferPlanBody) {
    const rail = this.rails.get(body.provider);
    if (!rail.capabilities().assetKinds.includes(body.asset.kind)) {
      throw new BadRequestException(`Rail ${body.provider} does not support asset kind ${body.asset.kind}`);
    }
    const plan = await createAssetTransferPlan({
      transactionId: body.transactionId,
      provider: body.provider,
      asset: body.asset,
      toAddress: body.toAddress,
    });
    const prepared = await rail.prepare(body.asset as AssetDescriptor);
    await setAssetTransferReference(plan.id, prepared.reference);
    return getAssetTransferPlan(plan.id);
  }

  async get(id: string) {
    const plan = await getAssetTransferPlan(id);
    if (!plan) throw new NotFoundException(`Asset transfer plan ${id} not found`);
    return plan;
  }

  /**
   * Execute the transfer on its rail — requires a valid approval token bound
   * to this exact plan + destination address (§13.5/§14, mirrors
   * settlement.release's separation-of-duties gate: proposer != approver).
   */
  async execute(id: string, principal: Principal, token: string | undefined) {
    const plan = await this.get(id);
    if (plan.status !== "pending") {
      throw new ConflictException(`Asset transfer plan ${id} is ${plan.status}, not executable`);
    }
    if (!plan.reference) {
      throw new ConflictException(`Asset transfer plan ${id} has no prepared rail reference`);
    }

    const payloadHash = hashAssetTransferTerms({ assetTransferPlanId: id, toAddress: plan.to_address });
    const verified = verifyApprovalToken(getConfig().security.approvalTokenSecret, token ?? "", {
      action: "execute_asset_transfer",
      payloadHash,
    });
    if (!verified.ok) throw new ForbiddenException(`Approval token invalid: ${verified.reason}`);

    const rail = this.rails.get(plan.provider);
    const result = await rail.execute({
      railId: rail.railId,
      reference: plan.reference,
      approvalTokenHash: payloadHash,
      asset: plan.asset_json as AssetDescriptor,
      toAddress: plan.to_address,
    });
    if (result.status === "failed") {
      await recordAssetTransferResult({ id, status: "failed", externalRef: result.externalRef, actorId: principal.userId });
      throw new ConflictException(`Rail execution failed on ${result.railId}`);
    }
    return recordAssetTransferResult({ id, status: result.status, externalRef: result.externalRef, actorId: principal.userId });
  }

  /** Poll the rail for a still-pending transfer's current status (no webhook reconciliation yet, see backlog). */
  async refreshStatus(id: string, principal: Principal) {
    const plan = await this.get(id);
    if (plan.status !== "pending" || !plan.external_ref) return plan;
    const rail = this.rails.get(plan.provider);
    const status = await rail.status(plan.external_ref);
    if (status.status === "pending") return plan;
    return recordAssetTransferResult({
      id,
      status: status.status,
      externalRef: status.externalRef ?? plan.external_ref,
      actorId: principal.userId,
    });
  }
}
