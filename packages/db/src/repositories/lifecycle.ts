import type { DemandSpecification } from "@opportunity-os/contracts";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";

export interface ActiveMissionForDiscovery {
  missionId: string;
  demandSpec: DemandSpecification;
}

/**
 * Active missions paired with their current immutable demand_spec — the input
 * set the scheduler re-drives discovery over each sweep (§11.1(10)).
 */
export async function listActiveMissionsForDiscovery(): Promise<ActiveMissionForDiscovery[]> {
  const rows = await getDb()
    .selectFrom("missions as m")
    .innerJoin("mission_versions as v", "v.id", "m.current_version_id")
    .where("m.status", "=", "active")
    .select(["m.id as missionId", "v.demand_spec_json as demandSpec"])
    .execute();
  // demand_spec_json was persisted from a validated DemandSpecification (§6.3).
  return rows.map((r) => ({ missionId: r.missionId, demandSpec: r.demandSpec as DemandSpecification }));
}

/**
 * §3.1(9) expire opportunities past their expires_at that no operator acted on.
 * Terminal/approved states are left untouched. Returns the number expired.
 */
export async function expireStaleOpportunities(nowIso: string): Promise<number> {
  const result = await getDb()
    .updateTable("opportunities")
    .set({ status: "expired" })
    .where("expires_at", "is not", null)
    .where("expires_at", "<", nowIso)
    .where("status", "in", ["candidate", "qualified", "awaiting_approval"])
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0n);
}

/**
 * §3.1(9) expire demands whose needed_by has passed, emitting demand.expired.v1
 * once per newly expired demand. Idempotent across sweeps.
 */
export async function expireOverdueDemands(nowIso: string): Promise<number> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const rows = await tx
        .selectFrom("demands")
        .select(["id"])
        .where("needed_by", "is not", null)
        .where("needed_by", "<", nowIso)
        .where("availability_status", "!=", "expired")
        .execute();
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => r.id);
      await tx.updateTable("demands").set({ availability_status: "expired" }).where("id", "in", ids).execute();
      for (const id of ids) {
        await enqueueEvent(tx, {
          eventName: "demand.expired.v1",
          aggregateType: "demand",
          aggregateId: id,
          idempotencyKey: `demand.expired:${id}`,
          payload: { demandId: id },
        });
      }
      return ids.length;
    });
}

/**
 * §3.1(9) mark still-"available" supply as unavailable once it has not been
 * re-observed since `cutoffIso` (ingestion stopped re-emitting it), emitting
 * supply.unavailable.v1 once per row. Idempotent across sweeps.
 */
export async function markStaleSupplyUnavailable(cutoffIso: string): Promise<number> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const rows = await tx
        .selectFrom("supply")
        .select(["id"])
        .where("availability_status", "=", "available")
        .where("last_verified_at", "is not", null)
        .where("last_verified_at", "<", cutoffIso)
        .execute();
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => r.id);
      await tx.updateTable("supply").set({ availability_status: "unavailable" }).where("id", "in", ids).execute();
      for (const id of ids) {
        await enqueueEvent(tx, {
          eventName: "supply.unavailable.v1",
          aggregateType: "supply",
          aggregateId: id,
          idempotencyKey: `supply.unavailable:${id}`,
          payload: { supplyId: id },
        });
      }
      return ids.length;
    });
}
