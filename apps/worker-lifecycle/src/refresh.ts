import {
  listActiveMissionsForDiscovery,
  expireStaleOpportunities,
  expireOverdueDemands,
  markStaleSupplyUnavailable,
} from "@opportunity-os/db";
import { runDiscoveryCycle, projectMissionDemand, synthesizeOpportunities } from "@opportunity-os/discovery";
import { createLogger } from "@opportunity-os/observability";

const log = createLogger("worker-lifecycle:refresh");

export interface RefreshSummary {
  expiredOpportunities: number;
  expiredDemands: number;
  staleSupply: number;
  missionsSwept: number;
  opportunitiesPersisted: number;
  synthesizedOpportunities: number;
}

/**
 * §3.1(9)/§11.1(10) — one lifecycle sweep. First refresh availability against
 * the current clock (expire overdue opportunities/demands, retire supply that
 * stopped being re-observed), THEN re-drive discovery for every active mission
 * so opportunities enter/refresh idempotently without manual hunting.
 *
 * Ordering matters: retire stale rows based on prior state BEFORE re-observing
 * current supply, otherwise the same sweep's re-ingestion would keep everything
 * perpetually fresh.
 */
export async function refreshCycle(supplyStaleMinutes: number): Promise<RefreshSummary> {
  const nowIso = new Date().toISOString();
  const staleCutoffIso = new Date(Date.now() - supplyStaleMinutes * 60_000).toISOString();

  const expiredOpportunities = await expireStaleOpportunities(nowIso);
  const expiredDemands = await expireOverdueDemands(nowIso);
  const staleSupply = await markStaleSupplyUnavailable(staleCutoffIso);

  const missions = await listActiveMissionsForDiscovery();
  let opportunitiesPersisted = 0;
  for (const m of missions) {
    const result = await runDiscoveryCycle({
      missionId: m.missionId,
      query: "",
      demand: projectMissionDemand(m.demandSpec),
    });
    opportunitiesPersisted += result.opportunitiesPersisted;
  }

  // Cross-source synthesis: match every open demand against all available
  // supply, so opportunities arise from independent signals (no listing).
  const synthesis = await synthesizeOpportunities();

  const summary: RefreshSummary = {
    expiredOpportunities,
    expiredDemands,
    staleSupply,
    missionsSwept: missions.length,
    opportunitiesPersisted,
    synthesizedOpportunities: synthesis.opportunitiesPersisted,
  };
  log.info(summary, "lifecycle.refresh.cycle");
  return summary;
}
