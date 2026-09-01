import type { DemandSpecification } from "@opportunity-os/contracts";
import type { DiscoveryDemand } from "./pipeline";

/** Buyer-urgency enum -> 0..1 time pressure used by scoring (§12). */
const URGENCY_SCORE: Record<string, number> = {
  immediate: 1,
  today: 0.85,
  days: 0.6,
  scheduled: 0.4,
  flexible: 0.2,
};

/**
 * Project an immutable MissionVersion demand_spec (§7) into the flattened
 * {@link DiscoveryDemand} the discovery pipeline matches and persists. Category
 * is not a first-class demand_spec field; it is read from an explicit
 * `category` quality constraint when the parser emitted one, otherwise left
 * null so matching relies on semantic + budget alignment.
 */
export function projectMissionDemand(spec: DemandSpecification): DiscoveryDemand {
  const categoryConstraint = spec.quality.constraints.find(
    (c) => c.field === "category" && typeof c.value === "string",
  );
  const target = spec.budget.target ?? null;
  const maximum = spec.budget.maximum ?? null;
  return {
    description: spec.what.description,
    category: categoryConstraint ? (categoryConstraint.value as string) : null,
    targetPriceMinor: target?.amount ?? null,
    maxBudgetMinor: maximum?.amount ?? null,
    currency: maximum?.currency ?? target?.currency ?? "USD",
    urgencyScore: URGENCY_SCORE[spec.timing.urgency] ?? 0.5,
  };
}
