import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { SettlementService, StripeFiatRail, StablecoinRail } from "@opportunity-os/settlement";
import { ProgrammableSettlementAdapter } from "@opportunity-os/chain";
import {
  getDb,
  closeDb,
  upsertGraphOpportunity,
  fundSettlementPlan,
  addMilestone,
  appendEvidence,
  listEvidenceClaims,
  verifyMilestone,
  releaseMilestone,
  getSettlementPlan,
  getMilestone,
  setSettlementPlanProviderRef,
} from "@opportunity-os/db";
import { evaluateCondition, decideRelease } from "@opportunity-os/escrow";
import { makeAttestationVerifier, makeSignedDocumentVerifier, signDocument } from "@opportunity-os/verifiers-sdk";
import { hashReleaseTerms } from "@opportunity-os/audit";
import type { EscrowCondition, SettlementPlan } from "@opportunity-os/contracts";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const SECRET = "rail-e2e-secret";

function rails(): SettlementService {
  const service = new SettlementService();
  service.register(new StripeFiatRail(undefined)); // simulated (no key)
  service.register(new StablecoinRail("local"));
  service.register(new ProgrammableSettlementAdapter("local"));
  return service;
}

function samplePlan(id: string, family: string): SettlementPlan {
  return {
    id,
    transaction_id: randomUUID(),
    rail_family: family as SettlementPlan["rail_family"],
    provider: family,
    asset: "USD",
    total_amount: { amount: 5000, currency: "USD" },
    status: "FUNDED",
    human_release_policy: "over_threshold",
    created_at: new Date().toISOString(),
  };
}

describe("settlement rails (no funds, deterministic)", () => {
  it("refuses to execute without an approval token hash (§13.5)", async () => {
    const service = rails();
    const rail = service.byFamily("onchain_programmable")[0]!;
    const { reference } = await rail.prepare(samplePlan(randomUUID(), "onchain_programmable"));
    await expect(
      service.execute({ railId: rail.railId, reference, approvalTokenHash: "", amount: { amount: 5000, currency: "USD" } }),
    ).rejects.toThrow(/approved action token/);
  });

  it("executes across rail families, returning a rail-specific external ref", async () => {
    const service = rails();
    const approvalTokenHash = "a".repeat(64);

    const chain = service.byFamily("onchain_programmable")[0]!;
    const chainRef = (await chain.prepare(samplePlan(randomUUID(), "onchain_programmable"))).reference;
    const chainExec = await service.execute({ railId: chain.railId, reference: chainRef, approvalTokenHash, amount: { amount: 5000, currency: "USD" } });
    expect(chainExec.status).toBe("confirmed");
    expect(chainExec.externalRef.startsWith("0x")).toBe(true);

    const fiat = service.byFamily("fiat")[0]!;
    const fiatRef = (await fiat.prepare(samplePlan(randomUUID(), "fiat"))).reference;
    expect(fiatRef.startsWith("sim_pi_")).toBe(true);
    const fiatExec = await service.execute({ railId: fiat.railId, reference: fiatRef, approvalTokenHash, amount: { amount: 5000, currency: "USD" } });
    expect(fiatExec.status).toBe("confirmed");
    expect(fiatExec.externalRef.startsWith("sim_capture_")).toBe(true);
  });
});

const attestation = makeAttestationVerifier();
const esign = makeSignedDocumentVerifier(SECRET);

function condition(documentId: string): EscrowCondition {
  return {
    all: [
      { predicate: { type: "shipment_delivered" } },
      { predicate: { type: "document_signed", documentId }, minTrust: "verified" },
    ],
  };
}

describe.skipIf(!HAS_DB)("release executes on the programmable rail (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("prepares at fund, executes on release, and records the rail external ref", async () => {
    const amountMinor = 5000;
    const { opportunityId } = await upsertGraphOpportunity({
      kind: "arbitrage",
      dedupeKey: `rail-${randomUUID()}`,
      expectedRevenueMinor: amountMinor,
      expectedDirectCostMinor: 0,
      expectedNetProfitMinor: amountMinor,
      currency: "USD",
      overallScore: 0.8,
      closeProbability: 0.8,
      customerValueScore: 0.8,
      scoreVersion: "v1",
      nextAction: "settle",
      source: { test: true },
    });
    const txn = await getDb()
      .insertInto("transactions")
      .values({
        opportunity_id: opportunityId,
        buyer_id: null,
        seller_id: null,
        status: "proposed",
        terms_version: 0,
        terms_hash: "t".repeat(64),
        gross_amount: { amount: amountMinor, currency: "USD" },
        currency: "USD",
        platform_revenue: null,
        settlement_plan_id: null,
        fulfillment_plan_id: null,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    const planRow = await getDb()
      .insertInto("settlement_plans")
      .values({
        transaction_id: txn.id,
        rail_family: "onchain_programmable",
        provider: "onchain-programmable",
        asset: "USDC",
        total_amount: { amount: amountMinor, currency: "USD" },
        status: "DRAFT",
        human_release_policy: "over_threshold",
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    // Fund: prepare the rail contract and persist its reference.
    const service = rails();
    const rail = service.byFamily("onchain_programmable")[0]!;
    const plan = (await getSettlementPlan(planRow.id))!;
    const prepared = await rail.prepare(plan as unknown as SettlementPlan);
    await setSettlementPlanProviderRef(planRow.id, prepared.reference);
    await fundSettlementPlan(planRow.id, "operator-1");

    // Evidence -> verify.
    const documentId = `doc-${randomUUID()}`;
    const milestone = await addMilestone({
      settlementPlanId: planRow.id,
      sequence: 0,
      name: "delivery",
      amount: { kind: "amount", value: amountMinor },
      releaseConditions: condition(documentId),
    });
    await appendEvidence({
      entityType: "settlement_milestone",
      entityId: milestone.id,
      claim: attestation.verify({ predicateType: "shipment_delivered", payload: { attested: true, delivered: true } })!,
    });
    await appendEvidence({
      entityType: "settlement_milestone",
      entityId: milestone.id,
      claim: esign.verify({ predicateType: "document_signed", payload: { documentId, signature: signDocument(SECRET, documentId) } })!,
    });
    const evalResult = evaluateCondition(condition(documentId), await listEvidenceClaims("settlement_milestone", milestone.id));
    expect(evalResult.satisfied).toBe(true);
    await verifyMilestone(milestone.id, "system");

    // Release -> execute on the rail, then persist the external ref.
    const decision = decideRelease({
      humanReleasePolicy: "over_threshold",
      amountMinor,
      thresholdMinor: 100000,
      conditionSatisfied: true,
      disputed: false,
      now: new Date(),
    });
    expect(decision.decision).toBe("auto_release");

    const execution = await service.execute({
      railId: rail.railId,
      reference: prepared.reference,
      approvalTokenHash: hashReleaseTerms({ milestoneId: milestone.id, amountMinor, currency: "USD" }),
      amount: { amount: amountMinor, currency: "USD" },
    });
    expect(execution.status).toBe("confirmed");

    await releaseMilestone({
      milestoneId: milestone.id,
      amountMinor,
      currency: "USD",
      actorId: "operator-1",
      externalTransactionRef: execution.externalRef,
      reason: decision.reason,
    });

    // The rail external ref is recorded and the rail contract is settled.
    expect((await getMilestone(milestone.id))!.external_transaction_ref).toBe(execution.externalRef);
    const finalPlan = (await getSettlementPlan(planRow.id))!;
    expect(finalPlan.status).toBe("SETTLED");
    expect(finalPlan.provider_ref).toBe(prepared.reference);
    expect((await rail.status(prepared.reference)).status).toBe("confirmed");
  });
});
