import type { AssetDescriptor } from "@opportunity-os/contracts";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";
import { appendAuditEvent } from "./audit";

/**
 * §19 crypto-asset expansion — persistence for `AssetTransferService`
 * (`@opportunity-os/settlement`). One row per transfer, not milestone-based
 * like settlement_plans/milestones: an asset transfer moves a single
 * object/position, not a phased amount. No domain state machine yet (unlike
 * settlement's SETTLEMENT_TRANSITIONS) — dispute/freeze/reclaim persistence
 * is left for when a reclaim-capable rail (e.g. ProgrammableAssetTransferAdapter)
 * is actually wired in here; CircleNftRail, the first rail wired, doesn't
 * support it (`capabilities().supportsReclaim === false`).
 */

export interface CreateAssetTransferPlanInput {
  transactionId: string;
  provider: string;
  asset: AssetDescriptor;
  toAddress: string;
}

export async function createAssetTransferPlan(input: CreateAssetTransferPlanInput) {
  return getDb()
    .insertInto("asset_transfer_plans")
    .values({
      transaction_id: input.transactionId,
      provider: input.provider,
      asset_kind: input.asset.kind,
      asset_json: JSON.stringify(input.asset),
      to_address: input.toAddress,
      reference: null,
      external_ref: null,
      status: "pending",
      executed_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getAssetTransferPlan(id: string) {
  return getDb().selectFrom("asset_transfer_plans").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function listAssetTransferPlansForTransaction(transactionId: string) {
  return getDb()
    .selectFrom("asset_transfer_plans")
    .selectAll()
    .where("transaction_id", "=", transactionId)
    .orderBy("created_at", "asc")
    .execute();
}

/** Record the rail's prepare() reference (contract/wallet-scoped locator), once, at first prepare. */
export async function setAssetTransferReference(id: string, reference: string): Promise<void> {
  await getDb()
    .updateTable("asset_transfer_plans")
    .set({ reference })
    .where("id", "=", id)
    .where("reference", "is", null)
    .execute();
}

export interface RecordAssetTransferResultInput {
  id: string;
  status: "pending" | "confirmed" | "failed" | "reclaimed";
  externalRef: string;
  actorId: string;
}

function auditActionFor(status: RecordAssetTransferResultInput["status"]): string {
  if (status === "confirmed") return "asset_transfer.executed";
  if (status === "reclaimed") return "asset_transfer.reclaimed";
  return "asset_transfer.failed";
}

/**
 * Persist a rail's execute()/status() result. Only "confirmed"/"failed"/
 * "reclaimed" are terminal (guarded by the `where status = 'pending'`) — a
 * re-poll of an already-pending transfer just updates external_ref idempotently.
 */
export async function recordAssetTransferResult(input: RecordAssetTransferResultInput) {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const updated = await tx
        .updateTable("asset_transfer_plans")
        .set({
          status: input.status,
          external_ref: input.externalRef,
          ...(input.status !== "pending" ? { executed_at: new Date().toISOString() } : {}),
        })
        .where("id", "=", input.id)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirst();
      if (!updated) return getAssetTransferPlan(input.id);

      await appendAuditEvent(tx, {
        actorType: "operator",
        actorId: input.actorId,
        action: auditActionFor(input.status),
        entityType: "asset_transfer_plan",
        entityId: input.id,
      });
      if (input.status !== "pending") {
        await enqueueEvent(tx, {
          eventName: "asset_transfer.executed.v1",
          aggregateType: "asset_transfer_plan",
          aggregateId: input.id,
          idempotencyKey: `asset_transfer.executed:${input.id}`,
          payload: { assetTransferPlanId: input.id, status: input.status, externalRef: input.externalRef },
        });
      }
      return updated;
    });
}
