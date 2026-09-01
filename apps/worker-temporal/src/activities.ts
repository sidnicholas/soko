/**
 * Temporal activity surface. The discovery pipeline itself lives in
 * @opportunity-os/discovery so the lifecycle worker and the durable workflow
 * share ONE implementation (no logic divergence). Temporal invokes these as
 * activities; the workflow proxies them by `typeof` this module.
 */
export { runDiscoveryCycle } from "@opportunity-os/discovery";
export type { DiscoveryInput, DiscoveryResult, DiscoveryDemand } from "@opportunity-os/discovery";
