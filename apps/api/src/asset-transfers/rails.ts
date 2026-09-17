import { AssetTransferService, CircleNftRail } from "@opportunity-os/settlement";
import { ProgrammableAssetTransferAdapter } from "@opportunity-os/chain";
import type { AppConfig } from "@opportunity-os/config";

/**
 * §19 crypto-asset expansion — registered asset-transfer rails, mirroring
 * `settlement/rails.ts`'s composition pattern (app layer is the only place
 * allowed to depend on both the abstraction and the on-chain adapter).
 * `CircleNftRail` reuses the same Circle Developer-Controlled Wallets config
 * as the stablecoin rail (§C-6 platform never holds keys directly); simulated
 * with no Circle config, same duality as every other Circle-backed rail.
 */
export function createAssetTransferService(config: AppConfig): AssetTransferService {
  const service = new AssetTransferService();
  service.register(
    new CircleNftRail(
      config.settlement.defaultStablecoinNetwork,
      config.settlement.circleApiKey && config.settlement.circleEntitySecret && config.settlement.circleWalletId
        ? {
            apiKey: config.settlement.circleApiKey,
            entitySecret: config.settlement.circleEntitySecret,
            walletId: config.settlement.circleWalletId,
          }
        : undefined,
    ),
  );
  service.register(new ProgrammableAssetTransferAdapter(config.settlement.chainRpcUrl ? "testnet" : "local"));
  return service;
}
