import { createHash } from "node:crypto";
import { initiateDeveloperControlledWalletsClient, type CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import type { Money, SettlementPlan } from "@opportunity-os/contracts";
import type {
  ApprovedSettlement,
  ExecutionResult,
  PreparedSettlement,
  ProviderSettlementStatus,
  RailCapabilities,
  RefundResult,
  SettlementQuote,
  SettlementRail,
} from "./index";

const USDC_SYMBOL = "USDC";

export interface CircleConfig {
  apiKey: string;
  entitySecret: string;
  /** The platform's own custodial wallet id (Circle Developer-Controlled Wallets) holding USDC. */
  walletId: string;
}

/** USD-cents (this system's universal Money unit) -> a USDC decimal-string amount, assuming a 1:1 peg. */
function centsToUsdcDecimal(amountMinor: number): string {
  return (amountMinor / 100).toFixed(6);
}

/**
 * Circle's `idempotencyKey` must be UUID-shaped (confirmed against the live
 * API — an arbitrary string, even a unique one, is rejected with "API
 * parameter invalid"). Deterministic so a retried execute() reuses the same
 * key for the same recipient (real idempotency), unlike `randomUUID()`.
 * Not a spec-correct UUIDv5 — just a valid-shaped v4-looking string derived
 * from a SHA-256 of the seed, which is all Circle's validation requires.
 */
function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * §19.2 Stablecoin rail exposed through a provider capability abstraction.
 * Asset/network are configurable. Simulated (deterministic, no funds moved)
 * with no Circle config; real Circle Developer-Controlled Wallets calls
 * otherwise — Circle holds the platform's keys (MPC custody), so this stays
 * consistent with §C-6 "platform never holds private keys" the way a direct
 * on-chain signing integration would not.
 */
export class StablecoinRail implements SettlementRail {
  readonly railId = "stablecoin";
  readonly family = "stablecoin" as const;
  private readonly client?: CircleDeveloperControlledWalletsClient;
  private tokenIdCache?: string;

  constructor(
    private readonly network: string,
    private readonly assets: readonly string[] = ["USDC"],
    private readonly circle?: CircleConfig,
  ) {
    if (circle) {
      this.client = initiateDeveloperControlledWalletsClient({ apiKey: circle.apiKey, entitySecret: circle.entitySecret });
    }
  }

  private get simulated(): boolean {
    return this.client === undefined;
  }

  capabilities(): RailCapabilities {
    return {
      family: "stablecoin",
      supportsMilestones: true,
      // No "reverse this charge" primitive on-chain, only "send more USDC
      // somewhere" — and no buyer refund address is tracked anywhere in the
      // data model yet (ST-12 recipients are payout destinations). Honest
      // false, not a fake refund.
      supportsRefund: false,
      supportsMultiRecipient: true,
      supportsDispute: true,
      assets: this.assets,
    };
  }

  async quote(plan: SettlementPlan): Promise<SettlementQuote> {
    // Flat simulated network fee in minor units of the asset.
    return { railId: this.railId, fee: { amount: 5, currency: plan.asset }, etaSeconds: 15, asset: plan.asset };
  }

  /**
   * Unlike Stripe's authorize/capture split, there is nothing to prepare
   * ahead of time on-chain: the platform's custodial wallet either already
   * holds enough USDC or it doesn't, and the real work happens at execute().
   * The wallet id doubles as the "reference" every milestone/plan shares
   * (`capabilities().supportsMilestones: true` — unlike Stripe, nothing here
   * is consumed by capturing it once).
   */
  async prepare(plan: SettlementPlan): Promise<PreparedSettlement> {
    if (this.simulated) {
      return { railId: this.railId, reference: `${this.network}:intent:${plan.id}` };
    }
    return { railId: this.railId, reference: this.circle!.walletId };
  }

  /** The wallet's own USDC token id, looked up once (Circle transfers address tokens by id, not symbol). */
  private async usdcTokenId(): Promise<string> {
    if (this.tokenIdCache) return this.tokenIdCache;
    const balances = await this.client!.getWalletTokenBalance({ id: this.circle!.walletId });
    const usdc = balances.data?.tokenBalances?.find((b) => b.token.symbol === USDC_SYMBOL);
    if (!usdc) throw new Error(`Circle wallet ${this.circle!.walletId} has no ${USDC_SYMBOL} token balance registered`);
    this.tokenIdCache = usdc.token.id;
    return usdc.token.id;
  }

  /**
   * On-chain transfers always need a real destination — there is no implicit
   * "platform balance" landing zone the way Stripe's capture has, so this
   * requires at least one ST-12 recipient even for a "single payee" release.
   * Circle transfers are asynchronous (INITIATED -> ... -> COMPLETE, minutes
   * away, not milliseconds): this always returns "pending" in real mode and
   * relies on webhook reconciliation (ST-13) to finalize, never a synchronous
   * "confirmed".
   */
  async execute(approved: ApprovedSettlement): Promise<ExecutionResult> {
    if (this.simulated) {
      const recipients = approved.recipients?.map((r) => ({
        address: r.address,
        amount: r.amount,
        externalRef: `0xsim${simpleHash(approved.reference + r.address)}`,
      }));
      const txHash = `0xsim${simpleHash(approved.reference + approved.approvalTokenHash)}`;
      return { railId: this.railId, externalRef: txHash, status: "confirmed", ...(recipients ? { recipients } : {}) };
    }
    if (!approved.recipients?.length) {
      throw new Error("Circle transfers require at least one recipient address (ST-12) — there is no implicit destination for an on-chain payout");
    }
    const tokenId = await this.usdcTokenId();
    const transfers = await Promise.all(
      approved.recipients.map(async (r) => {
        const result = await this.client!.createTransaction({
          walletId: this.circle!.walletId,
          tokenId,
          destinationAddress: r.address,
          amount: [centsToUsdcDecimal(r.amount.amount)],
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
          // Reused approvalTokenHash (already a deterministic hash of the
          // exact release terms), salted per recipient — a retried execute()
          // reuses the same key per transfer instead of sending it twice.
          idempotencyKey: deterministicUuid(`${approved.approvalTokenHash}:${r.address}`),
        });
        if (!result.data?.id) throw new Error(`Circle createTransaction returned no transaction id for ${r.address}`);
        return { address: r.address, amount: r.amount, externalRef: result.data.id };
      }),
    );
    return { railId: this.railId, externalRef: transfers[0]!.externalRef, status: "pending", recipients: transfers };
  }

  async status(ref: string): Promise<ProviderSettlementStatus> {
    if (this.simulated) return { status: "confirmed", externalRef: ref };
    const result = await this.client!.getTransaction({ id: ref });
    const state = result.data?.transaction?.state;
    if (state === "COMPLETE") return { status: "confirmed", externalRef: ref };
    if (state === "FAILED" || state === "DENIED" || state === "CANCELLED" || state === "STUCK") {
      return { status: "failed", externalRef: ref };
    }
    return { status: "pending", externalRef: ref };
  }

  async refund(ref: string, _amount: Money): Promise<RefundResult> {
    return { externalRef: `refund:${ref}`, status: "failed" };
  }
}

function simpleHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}
