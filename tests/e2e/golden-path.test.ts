import { describe, it, expect } from "vitest";
import type { AuditEvent, DemandSpecification, SettlementPlan } from "@opportunity-os/contracts";
import { ConnectorRegistry, FixtureSupplyConnector, normalizeObservation, type NormalizedSupply } from "@opportunity-os/connectors-sdk";
import { computeEconomics, scoreOpportunity } from "@opportunity-os/scoring";
import { assessRisk, isTransactableInV1 } from "@opportunity-os/risk";
import { AuditChain, verifyChain, computeBatchRoot } from "@opportunity-os/audit";
import { ProgrammableSettlementAdapter } from "@opportunity-os/chain";

/**
 * §26 End-to-End Golden Path, exercised in-process across the real packages
 * (no external services). Mirrors the spec's numbered golden path: mission ->
 * connector supply -> normalize -> match/score -> risk -> approval -> transaction
 * -> settlement plan -> funding -> milestone -> release -> audit chain validates.
 */
describe("golden path (in-process integration)", () => {
  it("runs mission -> opportunity -> approved settlement with a valid audit chain", async () => {
    const audit = new AuditChain();
    const events: AuditEvent[] = [];
    const draft = (n: number, action: string, entityType: string, entityId: string) =>
      audit.append({
        id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
        actor_type: "system",
        actor_id: "golden-path",
        action,
        entity_type: entityType,
        entity_id: entityId,
        input_hash: null,
        output_hash: null,
        policy_version: "v1",
        model_provider: null,
        model: null,
        model_version: null,
        confidence: null,
        created_at: "2026-08-31T00:00:00.000Z",
      });

    // 1. Mission with a structured demand specification.
    const missionId = "mission-1";
    const spec: DemandSpecification = {
      what: { description: "27-inch 4K monitor under $220" },
      budget: { maximum: { amount: 22000, currency: "USD" }, flexible: true },
      quality: { constraints: [] },
      timing: { urgency: "days" },
      payment: { acceptableMethods: ["card"] },
      fulfillment: { type: "ship" },
      flexibility: { substitutesAllowed: true, negotiableFields: ["price"], nonNegotiables: [] },
      negotiationAuthorization: { mayPrepare: true, maySend: false },
    };
    expect(spec.negotiationAuthorization.maySend).toBe(false);
    events.push(draft(1, "mission.created", "mission", missionId));

    // 2-3. Connector supply + normalization.
    const registry = new ConnectorRegistry();
    registry.register(FixtureSupplyConnector);
    const raw = await registry.get("fixture-supply")!.search({ query: "4K monitor", category: "electronics", max: 10, filters: {} });
    const supply = raw.map(normalizeObservation).filter((n): n is NormalizedSupply => n.kind === "supply");
    expect(supply.length).toBeGreaterThan(0);
    events.push(draft(2, "supply.discovered", "supply", supply[0]!.external_ref));

    // 4-6. Match economics + deterministic score + risk gate.
    const best = supply[0]!;
    const econ = computeEconomics({ expectedRevenueUsd: 220, expectedDirectCostUsd: (best.price?.amount ?? 0) / 100, capitalRequiredUsd: 0 });
    const risk = assessRisk({ contentHash: best.content_hash, seenHashes: [] }, best.category);
    const score = scoreOpportunity({
      expected_net_profit_usd: econ.expectedNetProfitUsd,
      gross_margin_pct: econ.grossMarginPct,
      capital_required_usd: 0,
      expected_minutes_human: 0,
      expected_minutes_elapsed: 30,
      close_probability: 0.9,
      buyer_intent: 0.8,
      urgency: 0.6,
      payment_certainty: 0.9,
      supply_confidence: best.source_reliability,
      repeatability: 0.5,
      customer_value: 0.6,
      fraud_risk: risk.fraud_risk,
      compliance_risk: risk.compliance_risk,
      operational_friction: 0.2,
      source_reliability: best.source_reliability,
    });
    expect(isTransactableInV1(best.category)).toBe(true);
    expect(score.overall).toBeGreaterThan(0);
    events.push(draft(3, "opportunity.qualified", "opportunity", "opp-1"));

    // 7-8. Human approval (simulated) then transaction proposed.
    const approvalTokenHash = "a".repeat(64);
    events.push(draft(4, "approval.approved", "approval", "appr-1"));
    events.push(draft(5, "transaction.proposed", "transaction", "txn-1"));

    // 9-16. Progressive settlement on the programmable rail (local reference).
    const rail = new ProgrammableSettlementAdapter("local");
    const plan: SettlementPlan = {
      id: "plan-1",
      transaction_id: "txn-1",
      rail_family: "onchain_programmable",
      provider: "onchain-programmable",
      asset: "USDC",
      total_amount: { amount: 22000, currency: "USDC" },
      status: "DRAFT",
      human_release_policy: "always",
      created_at: "2026-08-31T00:00:00.000Z",
    };
    const prepared = await rail.prepare(plan);
    rail.fund(prepared.reference);
    rail.addMilestone(prepared.reference, 0, { name: "delivery", pct: 100 });
    rail.verifyMilestone(prepared.reference, 0);
    const execution = await rail.execute({ railId: rail.railId, reference: prepared.reference, approvalTokenHash, amount: plan.total_amount });
    expect(execution.status).toBe("confirmed");
    expect((await rail.status(prepared.reference)).status).toBe("confirmed");
    events.push(draft(6, "settlement.released", "transaction", "txn-1"));
    events.push(draft(7, "transaction.closed", "transaction", "txn-1"));

    // 17. Audit chain validates end to end.
    expect(verifyChain(events)).toEqual({ ok: true });
    expect(computeBatchRoot(events.map((e) => e.event_hash))).toHaveLength(64);
  });
});
