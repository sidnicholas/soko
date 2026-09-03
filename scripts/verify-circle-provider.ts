/**
 * Verifies the real Circle Developer-Controlled Wallets wiring:
 *  - a pure-crypto self-test of the webhook signature verification (no Circle
 *    account needed — mirrors scripts/verify-stripe-provider.ts's
 *    generateTestHeaderString check)
 *  - against the live Circle sandbox API + Base Sepolia testnet, if
 *    credentials are set: a real USDC transfer from the configured wallet to
 *    a freshly-created temporary destination wallet, confirmed on-chain.
 *
 * Run (crypto self-test only):
 *   pnpm exec tsx scripts/verify-circle-provider.ts
 * Run (full, live):
 *   CIRCLE_API_KEY=... CIRCLE_ENTITY_SECRET=... CIRCLE_WALLET_ID=... \
 *     pnpm exec tsx scripts/verify-circle-provider.ts
 * The wallet must already hold testnet USDC (Base Sepolia faucet). Moves no
 * real money (testnet only).
 */
import { generateKeyPairSync, sign as signEcdsa } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { StablecoinRail } from "@opportunity-os/settlement";
import { hashReleaseTerms } from "@opportunity-os/audit";
import { verifyCircleSignature } from "../apps/api/src/webhooks/webhooks.service";

let failures = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? ` — ${String(detail)}` : ""}`);
  if (!cond) failures++;
}

function verifyWebhookCrypto(): void {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const body = Buffer.from(JSON.stringify({ notification: { id: "txn-verify", state: "COMPLETE" } }));
  const signature = signEcdsa("sha256", body, privateKey).toString("base64");

  check(verifyCircleSignature(body, signature, publicKeyPem), "verifyCircleSignature accepts a correctly-signed payload");

  const { publicKey: otherKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const otherPem = otherKey.export({ type: "spki", format: "pem" }).toString();
  let rejectedWrongKey = false;
  try {
    rejectedWrongKey = !verifyCircleSignature(body, signature, otherPem);
  } catch {
    rejectedWrongKey = true; // A mismatched key/signature can also throw rather than return false.
  }
  check(rejectedWrongKey, "verifyCircleSignature rejects a signature verified against the wrong public key");

  const tampered = Buffer.from(JSON.stringify({ notification: { id: "txn-verify", state: "FAILED" } }));
  check(!verifyCircleSignature(tampered, signature, publicKeyPem), "verifyCircleSignature rejects a tampered payload");
}

async function verifyLiveTransfer(): Promise<void> {
  const apiKey = process.env.CIRCLE_API_KEY!;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET!;
  const walletId = process.env.CIRCLE_WALLET_ID!;

  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const rail = new StablecoinRail("base-sepolia", ["USDC"], { apiKey, entitySecret, walletId });

  const balances = await client.getWalletTokenBalance({ id: walletId });
  const usdc = balances.data?.tokenBalances?.find((b) => b.token.symbol === "USDC");
  check(Boolean(usdc), "configured wallet holds a USDC balance", usdc?.amount);
  if (!usdc) {
    console.error("\nFund the wallet with testnet USDC (Base Sepolia faucet) before running the live check.");
    process.exit(1);
  }

  const wallet = await client.getWallet({ id: walletId });
  const walletSetId = wallet.data?.wallet?.walletSetId;
  check(Boolean(walletSetId), "resolved the configured wallet's wallet set", walletSetId);
  if (!walletSetId) {
    console.error("\nCould not resolve a wallet set for the configured wallet.");
    process.exit(1);
  }

  // A temporary destination wallet under the same set — proves a real
  // transfer end-to-end without needing a second pre-provisioned account.
  const destWallets = await client.createWallets({ accountType: "SCA", blockchains: ["BASE-SEPOLIA"], count: 1, walletSetId });
  const destination = destWallets.data?.wallets?.[0];
  check(Boolean(destination?.address), "created a temporary destination wallet", destination?.address);
  if (!destination?.address) {
    process.exit(1);
  }

  const amountMinor = 1; // 1 cent -> 0.01 USDC, smallest sane test transfer.
  const execution = await rail.execute({
    railId: rail.railId,
    reference: walletId,
    approvalTokenHash: hashReleaseTerms({ milestoneId: `verify-circle-${Date.now()}`, amountMinor, currency: "USD" }),
    amount: { amount: amountMinor, currency: "USD" },
    recipients: [{ address: destination.address, amount: { amount: amountMinor, currency: "USD" } }],
  });
  check(execution.status === "pending", "execute() reports pending (Circle transfers are never synchronously confirmed)", execution.externalRef);
  check(Boolean(execution.recipients?.[0]?.externalRef), "execute() returns a per-recipient transaction id");

  console.log("Waiting for on-chain confirmation (this can take a minute)...");
  try {
    const confirmed = await client.getTransaction({
      id: execution.externalRef,
      waitForState: "COMPLETE",
      signal: AbortSignal.timeout(120_000),
    });
    check(confirmed.data?.transaction?.state === "COMPLETE", "transaction reaches COMPLETE on Base Sepolia", confirmed.data?.transaction?.state);
  } catch (err) {
    check(false, "transaction reaches COMPLETE on Base Sepolia", err);
  }

  const status = await rail.status(execution.externalRef);
  check(status.status === "confirmed", "status() maps the confirmed transaction to \"confirmed\"", status.status);
}

async function main(): Promise<void> {
  verifyWebhookCrypto();

  const hasCredentials = process.env.CIRCLE_API_KEY && process.env.CIRCLE_ENTITY_SECRET && process.env.CIRCLE_WALLET_ID;
  if (hasCredentials) {
    await verifyLiveTransfer();
  } else {
    console.log("\nCIRCLE_API_KEY / CIRCLE_ENTITY_SECRET / CIRCLE_WALLET_ID not set — skipping the live transfer check (webhook crypto self-test only).");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify crashed:", err);
  process.exit(1);
});
