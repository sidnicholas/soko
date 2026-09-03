/**
 * Verifies the durable Settlement Milestone Timer Workflow (§20/ST-13) against
 * the Temporal time-skipping test server with REAL activities and Postgres:
 *  - deadman elapsed, conditions unmet   -> auto-refund, no manual call
 *  - optimistic window elapsed, below threshold -> auto-release an unverified milestone
 *  - plan disputed                        -> held, no automatic money movement
 *
 * Run: DATABASE_URL=... pnpm exec tsx scripts/verify-settlement-timer-workflow.ts
 */
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  getDb,
  closeDb,
  upsertGraphOpportunity,
  fundSettlementPlan,
  addMilestone,
  disputeMilestone,
  getSettlementPlan,
  getMilestone,
} from "@opportunity-os/db";
import * as activities from "../apps/worker-temporal/src/activities";
import { settlementMilestoneTimerWorkflow } from "../apps/worker-temporal/src/workflows";

const TASK_QUEUE = "verify-settlement-timer";

let failures = 0;
function check(cond: boolean, label: string): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

async function fundedPlanWithMilestone(
  amountMinor: number,
  policy: string,
  windows: { optimisticAfterAt?: string | null; deadmanAt?: string | null },
): Promise<{ planId: string; milestoneId: string }> {
  const { opportunityId } = await upsertGraphOpportunity({
    kind: "arbitrage",
    dedupeKey: `settlement-timer-${randomUUID()}`,
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

  const plan = await getDb()
    .insertInto("settlement_plans")
    .values({
      transaction_id: txn.id,
      rail_family: "fiat",
      provider: "stripe-test",
      asset: "USD",
      total_amount: { amount: amountMinor, currency: "USD" },
      status: "DRAFT",
      human_release_policy: policy,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();

  await getDb().updateTable("transactions").set({ settlement_plan_id: plan.id }).where("id", "=", txn.id).execute();
  await fundSettlementPlan(plan.id, "operator-1");

  const milestone = await addMilestone({
    settlementPlanId: plan.id,
    sequence: 0,
    name: "delivery",
    amount: { kind: "amount", value: amountMinor },
    releaseConditions: { predicate: { type: "shipment_delivered" } },
    optimisticAfterAt: windows.optimisticAfterAt ?? null,
    deadmanAt: windows.deadmanAt ?? null,
  });

  return { planId: plan.id, milestoneId: milestone.id };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const past = new Date(Date.now() - 60_000).toISOString();

  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("../apps/worker-temporal/src/workflows.ts", import.meta.url)),
    activities,
  });

  await worker.runUntil(async () => {
    // Deadman already elapsed, conditions unmet -> automatic refund.
    const deadman = await fundedPlanWithMilestone(5000, "over_threshold", { deadmanAt: past });
    const deadmanResult = await env.client.workflow.execute(settlementMilestoneTimerWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: `timer-deadman-${deadman.milestoneId}`,
      args: [{ milestoneId: deadman.milestoneId }],
    });
    check(deadmanResult.action === "refunded", "deadman elapsed -> workflow reports refunded");
    check((await getMilestone(deadman.milestoneId))!.status === "refunded", "deadman elapsed -> milestone persisted as refunded");
    check((await getSettlementPlan(deadman.planId))!.status === "REFUNDED", "deadman elapsed -> plan persisted as REFUNDED");

    // Optimistic window elapsed, below threshold -> automatic release of a still-unverified milestone.
    const optimistic = await fundedPlanWithMilestone(5000, "over_threshold", { optimisticAfterAt: past });
    const optimisticResult = await env.client.workflow.execute(settlementMilestoneTimerWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: `timer-optimistic-${optimistic.milestoneId}`,
      args: [{ milestoneId: optimistic.milestoneId }],
    });
    check(optimisticResult.action === "released", "optimistic window elapsed -> workflow reports released");
    check((await getMilestone(optimistic.milestoneId))!.status === "released", "optimistic window elapsed -> milestone persisted as released (never got evidence)");

    // Disputed plan -> held, no automatic money movement even with a blown deadman.
    const disputed = await fundedPlanWithMilestone(5000, "over_threshold", { deadmanAt: past });
    await disputeMilestone({ milestoneId: disputed.milestoneId, actorId: "operator-1", reason: "quality concern" });
    const disputedResult = await env.client.workflow.execute(settlementMilestoneTimerWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: `timer-disputed-${disputed.milestoneId}`,
      args: [{ milestoneId: disputed.milestoneId }],
    });
    check(disputedResult.action === "held", "disputed plan -> workflow reports held, does not act");
    check((await getMilestone(disputed.milestoneId))!.status !== "refunded", "disputed plan -> milestone not auto-refunded despite blown deadman");
  });

  await env.teardown();
  await closeDb();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify crashed:", err);
  process.exit(1);
});
