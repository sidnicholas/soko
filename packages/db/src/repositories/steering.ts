import type { Transaction } from "kysely";
import { assertTransition, OPPORTUNITY_TRANSITIONS } from "@opportunity-os/domain";
import { EXCLUDE_TERM_FIELD, excludedTerms, type Constraint, type DemandSpecification, type OpportunityStatus } from "@opportunity-os/contracts";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";
import { appendAuditEvent } from "./audit";
import type { Database } from "../schema";

type Tx = Transaction<Database>;

/** The mission an opportunity was discovered for, if any (graph-derived deals have none). */
export async function getOpportunityMissionId(opportunityId: string): Promise<string | null | undefined> {
  const row = await getDb()
    .selectFrom("opportunities as o")
    .leftJoin("matches as m", "m.id", "o.match_id")
    .leftJoin("demands as d", "d.id", "m.demand_id")
    .select(["o.id", "d.mission_id"])
    .where("o.id", "=", opportunityId)
    .executeTakeFirst();
  if (!row) return undefined;
  return row.mission_id ?? null;
}

async function rejectInTx(tx: Tx, opportunityId: string, reason: string, actorId: string): Promise<boolean> {
  const opp = await tx.selectFrom("opportunities").select(["id", "status"]).where("id", "=", opportunityId).forUpdate().executeTakeFirstOrThrow();
  if (opp.status === "rejected") return false;
  assertTransition("opportunity", OPPORTUNITY_TRANSITIONS, opp.status as OpportunityStatus, "rejected");
  await tx
    .updateTable("opportunities")
    .set({ status: "rejected", rejection_reason: reason, rejected_by: actorId, rejected_at: new Date().toISOString() })
    .where("id", "=", opportunityId)
    .execute();
  await appendAuditEvent(tx, {
    actorType: "user",
    actorId,
    action: "opportunity.rejected",
    entityType: "opportunity",
    entityId: opportunityId,
  });
  return true;
}

export interface RejectOpportunityInput {
  opportunityId: string;
  reason: string;
  actorId: string;
}

/**
 * Set an opportunity aside with the user's reason. Terminal ('rejected') —
 * discovery re-scoring keeps it rejected (see rediscoveredStatus). Throws
 * InvalidTransitionError from a state that can't be rejected (approved/closed/expired).
 * Returns false if it was already rejected.
 */
export async function rejectOpportunity(input: RejectOpportunityInput): Promise<boolean> {
  return getDb()
    .transaction()
    .execute((tx) => rejectInTx(tx, input.opportunityId, input.reason, input.actorId));
}

/** Rejected opportunities for a mission, most recent first — the "rejected alternatives" view. */
export async function listRejectedOpportunities(missionId: string) {
  return getDb()
    .selectFrom("opportunities as o")
    .innerJoin("matches as m", "m.id", "o.match_id")
    .innerJoin("demands as d", "d.id", "m.demand_id")
    .innerJoin("supply as s", "s.id", "m.supply_id")
    .select(["o.id", "o.overall_score", "o.rejection_reason", "o.rejected_by", "o.rejected_at", "s.title as supply_title"])
    .where("d.mission_id", "=", missionId)
    .where("o.status", "=", "rejected")
    .orderBy("o.rejected_at", "desc")
    .execute();
}

export interface SteerMissionInput {
  missionId: string;
  excludeTerms: string[];
  note: string | null;
  actorId: string;
}

export interface SteerMissionResult {
  versionNumber: number;
  addedTerms: string[];
  rejectedOpportunityIds: string[];
}

/**
 * User→agent steering. Records the direction as a new immutable mission
 * version (so it's versioned and auditable like any constraint edit — §6.3),
 * with each exclusion as a hard `keyword neq <term>` constraint the discovery
 * pipeline honors on every future cycle. Open opportunities that already
 * match an excluded term are set aside now with a reason, rather than waiting
 * for them to age out. Emits mission.steered.v1 for the mission timeline.
 */
export async function steerMission(input: SteerMissionInput): Promise<SteerMissionResult> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const mission = await tx
        .selectFrom("missions")
        .select(["id", "current_version_id"])
        .where("id", "=", input.missionId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!mission.current_version_id) throw new Error(`Mission ${input.missionId} has no demand specification to steer`);
      const current = await tx
        .selectFrom("mission_versions")
        .select(["demand_spec_json", "version_number"])
        .where("id", "=", mission.current_version_id)
        .executeTakeFirstOrThrow();
      const spec = current.demand_spec_json as DemandSpecification;

      const existing = new Set(excludedTerms(spec).map((t) => t.toLowerCase()));
      const addedTerms: string[] = [];
      for (const raw of input.excludeTerms) {
        const term = raw.trim();
        if (term && !existing.has(term.toLowerCase())) {
          existing.add(term.toLowerCase());
          addedTerms.push(term);
        }
      }

      const constraints: Constraint[] = [
        ...spec.quality.constraints,
        ...addedTerms.map((term) => ({ field: EXCLUDE_TERM_FIELD, operator: "neq" as const, value: term, hard: true })),
      ];
      const nextSpec: DemandSpecification = { ...spec, quality: { ...spec.quality, constraints } };
      const last = await tx
        .selectFrom("mission_versions")
        .select(({ fn }) => fn.max("version_number").as("max"))
        .where("mission_id", "=", input.missionId)
        .executeTakeFirst();
      const versionNumber = Number(last?.max ?? -1) + 1;
      const reason = [addedTerms.length ? `exclude ${addedTerms.map((t) => `"${t}"`).join(", ")}` : null, input.note].filter(Boolean).join(" — ");
      const version = await tx
        .insertInto("mission_versions")
        .values({
          mission_id: input.missionId,
          version_number: versionNumber,
          demand_spec_json: JSON.stringify(nextSpec),
          changed_by: input.actorId,
          change_reason: `steer: ${reason || "note"}`,
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();
      await tx
        .updateTable("missions")
        .set({ current_version_id: version.id, updated_at: new Date().toISOString() })
        .where("id", "=", input.missionId)
        .execute();

      const rejectedOpportunityIds: string[] = [];
      for (const term of addedTerms) {
        const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const hits = await tx
          .selectFrom("opportunities as o")
          .innerJoin("matches as m", "m.id", "o.match_id")
          .innerJoin("demands as d", "d.id", "m.demand_id")
          .innerJoin("supply as s", "s.id", "m.supply_id")
          .select("o.id")
          .where("d.mission_id", "=", input.missionId)
          .where("o.status", "in", ["candidate", "qualified"])
          .where((eb) => eb.or([eb("s.title", "ilike", pattern), eb("s.description", "ilike", pattern)]))
          .execute();
        for (const hit of hits) {
          if (await rejectInTx(tx, hit.id, `Excluded by steering: "${term}"`, input.actorId)) rejectedOpportunityIds.push(hit.id);
        }
      }

      await enqueueEvent(tx, {
        eventName: "mission.steered.v1",
        aggregateType: "mission",
        aggregateId: input.missionId,
        idempotencyKey: `mission.steered:${input.missionId}:${versionNumber}`,
        payload: {
          missionId: input.missionId,
          versionNumber,
          addedTerms,
          rejectedOpportunities: rejectedOpportunityIds.length,
          summary: `${reason || "Note recorded"}${rejectedOpportunityIds.length ? ` · ${rejectedOpportunityIds.length} opportunit${rejectedOpportunityIds.length === 1 ? "y" : "ies"} set aside` : ""}`,
        },
      });
      return { versionNumber, addedTerms, rejectedOpportunityIds };
    });
}
