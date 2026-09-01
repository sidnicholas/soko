/**
 * Verifies the durable Opportunity Execution Workflow (§11.2) against the
 * Temporal time-skipping test server with REAL activities and Postgres:
 *  - approve  -> workflow executes the gated proposal (transaction persisted)
 *  - reject   -> workflow stops, no execution
 *  - timeout  -> approval wait elapses, workflow expires, no execution
 *
 * Run: DATABASE_URL=... pnpm exec tsx scripts/verify-execution-workflow.ts
 */
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { DemandSpecification } from "@opportunity-os/contracts";
import { createMission, decideApproval, getDb, closeDb, listOpportunitiesByMission } from "@opportunity-os/db";
import { runDiscoveryCycle } from "@opportunity-os/discovery";
import { mintApprovalToken } from "@opportunity-os/auth";
import { getConfig } from "@opportunity-os/config";
import * as activities from "../apps/worker-temporal/src/activities";
import { approvalSignal, opportunityExecutionWorkflow } from "../apps/worker-temporal/src/workflows";

const TASK_QUEUE = "verify-exec";
const SECRET = getConfig().security.approvalTokenSecret;

let failures = 0;
function check(cond: boolean, label: string): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

async function seedOpportunity(): Promise<{ opportunityId: string; userId: string }> {
  const user = await getDb()
    .insertInto("users")
    .values({ email: `exec-${Date.now()}@t.test`, display_name: "Op", role: "operator" })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  const spec: DemandSpecification = {
    what: { description: "Need a 27-inch 4K monitor under $220, delivered this week." },
    budget: { maximum: { amount: 22000, currency: "USD" }, flexible: true },
    quality: { constraints: [{ field: "category", operator: "eq", value: "electronics", hard: true }] },
    timing: { urgency: "days" },
    payment: { acceptableMethods: ["card"] },
    fulfillment: { type: "ship" },
    flexibility: { substitutesAllowed: true, negotiableFields: ["price"], nonNegotiables: [] },
    negotiationAuthorization: { mayPrepare: true, maySend: false },
  };
  const mission = await createMission({
    ownerUserId: user.id, title: "monitor", rawIntent: spec.what.description,
    autonomyPolicy: "discover_only", demandSpec: spec, changedBy: user.id,
  });
  await runDiscoveryCycle({
    missionId: mission.missionId, query: "",
    demand: { description: spec.what.description, category: "electronics", targetPriceMinor: null, maxBudgetMinor: 22000, currency: "USD", urgencyScore: 0.6 },
  });
  const opps = await listOpportunitiesByMission(mission.missionId);
  return { opportunityId: opps[0]!.id, userId: user.id };
}

async function waitForPendingApproval(opportunityId: string) {
  for (let i = 0; i < 50; i++) {
    const row = await getDb()
      .selectFrom("approvals")
      .selectAll()
      .where("entity_id", "=", opportunityId)
      .where("status", "=", "pending")
      .orderBy("expires_at", "desc")
      .executeTakeFirst();
    if (row) return row;
    await sleep(100);
  }
  throw new Error("approval was never created by the workflow");
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const { opportunityId, userId } = await seedOpportunity();

  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("../apps/worker-temporal/src/workflows.ts", import.meta.url)),
    activities,
  });

  const baseArgs = { opportunityId, grossAmountMinor: 22000, currency: "USD", requestedByAgent: userId };

  await worker.runUntil(async () => {
    // Approve -> executes the gated proposal.
    const approveHandle = await env.client.workflow.start(opportunityExecutionWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: `exec-approve-${opportunityId}`,
      args: [{ ...baseArgs, approvalTimeoutMinutes: 60 }],
    });
    const approval = await waitForPendingApproval(opportunityId);
    await decideApproval(approval.id, {
      status: "approved", decision: "approve", event: "approval.approved.v1", decidedBy: userId, metadata: {},
    });
    const token = mintApprovalToken(SECRET, {
      approvalId: approval.id, action: "propose_transaction", entityType: "opportunity",
      entityId: opportunityId, payloadHash: approval.payload_hash, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await approveHandle.signal(approvalSignal, { approved: true, token, decidedBy: userId });
    const approved = await approveHandle.result();
    check(approved.status === "executed" && Boolean(approved.transactionId), "approve -> executed with a transaction id");
    const txn = await getDb().selectFrom("transactions").selectAll().where("id", "=", approved.transactionId!).executeTakeFirst();
    check(txn?.status === "proposed", "approve -> transaction persisted as proposed");

    // Reject -> stops, no execution.
    const rejectHandle = await env.client.workflow.start(opportunityExecutionWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: `exec-reject-${opportunityId}`,
      args: [{ ...baseArgs, approvalTimeoutMinutes: 60 }],
    });
    await waitForPendingApproval(opportunityId);
    await rejectHandle.signal(approvalSignal, { approved: false });
    const rejected = await rejectHandle.result();
    check(rejected.status === "rejected" && rejected.transactionId === undefined, "reject -> rejected, no transaction");

    // Timeout -> approval wait elapses (time-skipped), workflow expires.
    const timeoutHandle = await env.client.workflow.start(opportunityExecutionWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: `exec-timeout-${opportunityId}`,
      args: [{ ...baseArgs, approvalTimeoutMinutes: 1 }],
    });
    const expired = await timeoutHandle.result();
    check(expired.status === "expired" && expired.transactionId === undefined, "timeout -> expired, no transaction");
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
