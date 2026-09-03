/**
 * Verifies the real Stripe test-mode wiring against the actual Stripe API
 * (no simulation): per-milestone PaymentIntents (the multi-capture fix),
 * idempotent execute, pre-capture cancel vs post-capture refund, and webhook
 * signature verification (a locally-generated secret — `constructEvent`
 * is pure crypto, it doesn't need to match a real endpoint's configured secret
 * to prove the verification logic itself works).
 *
 * Run: STRIPE_SECRET_KEY=sk_test_... pnpm exec tsx scripts/verify-stripe-provider.ts
 * Requires network egress to api.stripe.com. Moves no real money (test mode).
 */
import Stripe from "stripe";
import { StripeFiatRail } from "@opportunity-os/settlement";
import { hashReleaseTerms } from "@opportunity-os/audit";
import type { SettlementPlan } from "@opportunity-os/contracts";

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY is required (a Stripe TEST key, sk_test_...).");
  process.exit(1);
}

let failures = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? ` — ${String(detail)}` : ""}`);
  if (!cond) failures++;
}

const client = new Stripe(SECRET_KEY, { apiVersion: "2024-06-20" as Stripe.LatestApiVersion });
const rail = new StripeFiatRail(SECRET_KEY);

/** A confirmed, uncaptured (requires_capture) test PaymentIntent for `amountMinor`. */
async function authorizedIntent(amountMinor: number): Promise<Stripe.PaymentIntent> {
  return client.paymentIntents.create({
    amount: amountMinor,
    currency: "usd",
    capture_method: "manual",
    payment_method_types: ["card"],
    confirm: true,
    payment_method: "pm_card_visa",
  });
}

async function main(): Promise<void> {
  // 1) The multi-capture fix: two "milestones" of one plan get their OWN
  // PaymentIntents and both capture successfully — before the fix, the second
  // capture on a shared intent would fail with "already captured".
  const planId = `verify-${Date.now()}`;
  // hashReleaseTerms is deterministic on (milestoneId, amount, currency), and
  // it becomes the Stripe idempotency key — reusing "m1"/"m2" across repeated
  // runs of this script would collide with a *different* PaymentIntent each
  // run, which Stripe correctly rejects. Salt with the run-unique planId.
  const m1 = { plan: { ...basePlan(planId, 5000) }, milestoneId: `${planId}:m1`, amountMinor: 3000 };
  const m2 = { plan: { ...basePlan(planId, 5000) }, milestoneId: `${planId}:m2`, amountMinor: 2000 };

  for (const m of [m1, m2]) {
    const prepared = await rail.prepare({
      ...m.plan,
      id: m.milestoneId,
      total_amount: { amount: m.amountMinor, currency: "USD" },
    } as unknown as SettlementPlan);
    // Move the freshly-prepared intent to requires_capture with a test card.
    await client.paymentIntents.confirm(prepared.reference, { payment_method: "pm_card_visa" });
    const execution = await rail.execute({
      railId: rail.railId,
      reference: prepared.reference,
      approvalTokenHash: hashReleaseTerms({ milestoneId: m.milestoneId, amountMinor: m.amountMinor, currency: "USD" }),
      amount: { amount: m.amountMinor, currency: "USD" },
    });
    check(execution.status === "confirmed", `milestone ${m.milestoneId} captures its own PaymentIntent (${m.amountMinor})`, execution.externalRef);
  }

  // 2) Idempotent execute: retrying the exact same release (same approvalTokenHash)
  // against an ALREADY-captured intent must not throw "already captured" — Stripe
  // returns the cached response for a reused idempotency key instead of re-running it.
  const idem = await authorizedIntent(1500);
  const tokenHash = hashReleaseTerms({ milestoneId: `${planId}:idem-test`, amountMinor: 1500, currency: "USD" });
  const first = await rail.execute({ railId: rail.railId, reference: idem.id, approvalTokenHash: tokenHash, amount: { amount: 1500, currency: "USD" } });
  let retriedOk = true;
  try {
    const second = await rail.execute({ railId: rail.railId, reference: idem.id, approvalTokenHash: tokenHash, amount: { amount: 1500, currency: "USD" } });
    retriedOk = second.externalRef === first.externalRef;
  } catch (err) {
    retriedOk = false;
    console.error("  idempotent retry threw:", err);
  }
  check(retriedOk, "retried execute() with the same approvalTokenHash is idempotent (no double-capture error)");

  // 3) Pre-capture refund() cancels the hold instead of erroring on "not captured yet".
  const uncaptured = await authorizedIntent(2500);
  const canceled = await rail.refund(uncaptured.id, { amount: 2500, currency: "USD" });
  check(canceled.status === "refunded", "refund() on an uncaptured intent cancels the hold", canceled.externalRef);
  const canceledIntent = await client.paymentIntents.retrieve(uncaptured.id);
  check(canceledIntent.status === "canceled", "the intent is actually canceled on Stripe's side");

  // 4) Post-capture refund() creates a real Refund.
  const toRefund = await authorizedIntent(1000); // already confirmed -> requires_capture
  await rail.execute({ railId: rail.railId, reference: toRefund.id, approvalTokenHash: hashReleaseTerms({ milestoneId: `${planId}:refund-test`, amountMinor: 1000, currency: "USD" }), amount: { amount: 1000, currency: "USD" } });
  const refundResult = await rail.refund(toRefund.id, { amount: 1000, currency: "USD" });
  check(refundResult.status === "refunded", "refund() on a captured intent creates a real Refund", refundResult.externalRef);

  // 5) Webhook signature verification (pure crypto — any secret proves the logic).
  const testSecret = "whsec_verify_local_only";
  const fakeEvent = {
    id: "evt_verify_1",
    object: "event",
    type: "payment_intent.succeeded",
    data: { object: { id: toRefund.id, object: "payment_intent" } },
  };
  const payload = JSON.stringify(fakeEvent);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: testSecret });
  try {
    const verified = Stripe.webhooks.constructEvent(payload, header, testSecret);
    check(verified.id === fakeEvent.id, "constructEvent verifies a correctly-signed payload");
  } catch (err) {
    check(false, "constructEvent verifies a correctly-signed payload", err);
  }
  try {
    Stripe.webhooks.constructEvent(payload, header, "whsec_wrong_secret");
    check(false, "constructEvent rejects a payload signed with a different secret");
  } catch {
    check(true, "constructEvent rejects a payload signed with a different secret");
  }
  try {
    Stripe.webhooks.constructEvent(payload.replace("succeeded", "failed"), header, testSecret);
    check(false, "constructEvent rejects a tampered payload");
  } catch {
    check(true, "constructEvent rejects a tampered payload");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

function basePlan(id: string, totalMinor: number) {
  return {
    id,
    transaction_id: id,
    rail_family: "fiat" as const,
    provider: "stripe",
    asset: "USD",
    total_amount: { amount: totalMinor, currency: "USD" },
    status: "FUNDED" as const,
    human_release_policy: "over_threshold" as const,
    created_at: new Date().toISOString(),
  };
}

main().catch((err) => {
  console.error("verify crashed:", err);
  process.exit(1);
});
