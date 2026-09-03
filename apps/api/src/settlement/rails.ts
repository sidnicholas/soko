import { SettlementService, StripeFiatRail, StablecoinRail } from "@opportunity-os/settlement";
import { ProgrammableSettlementAdapter } from "@opportunity-os/chain";
import type { AppConfig } from "@opportunity-os/config";

/**
 * §19/§29 — the registered settlement rails, selected per plan by rail family.
 * Composed here because only the app layer may depend on both the settlement
 * abstraction and the on-chain adapter (settlement stays adapter-agnostic).
 * Fiat runs on Stripe test mode (simulated with no key); stablecoin and the
 * programmable chain are deterministic local references until a provider/audit
 * lands. Funds are never held by the platform (§19.1).
 */
export function createSettlementService(config: AppConfig): SettlementService {
  const service = new SettlementService();
  service.register(new StripeFiatRail(config.settlement.stripeSecretKey));
  service.register(
    new StablecoinRail(
      config.settlement.defaultStablecoinNetwork,
      undefined,
      config.settlement.circleApiKey && config.settlement.circleEntitySecret && config.settlement.circleWalletId
        ? {
            apiKey: config.settlement.circleApiKey,
            entitySecret: config.settlement.circleEntitySecret,
            walletId: config.settlement.circleWalletId,
          }
        : undefined,
    ),
  );
  service.register(new ProgrammableSettlementAdapter(config.settlement.chainRpcUrl ? "testnet" : "local"));
  return service;
}
