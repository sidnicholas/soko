import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./common/auth.guard";
import { HealthModule } from "./health/health.module";
import { MissionsModule } from "./missions/missions.module";
import { OpportunitiesModule } from "./opportunities/opportunities.module";
import { ApprovalsModule } from "./approvals/approvals.module";
import { TransactionsModule } from "./transactions/transactions.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { PublicModule } from "./public/public.module";
import { SignalsModule } from "./signals/signals.module";
import { EntitiesModule } from "./entities/entities.module";
import { SettlementModule } from "./settlement/settlement.module";
import { NegotiationsModule } from "./negotiations/negotiations.module";
import { AssetTransferModule } from "./asset-transfers/asset-transfer.module";
import { SearchModule } from "./search/search.module";
import { IntelModule } from "./intel/intel.module";
import { MarketplaceModule } from "./marketplace/marketplace.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { SourcesModule } from "./sources/sources.module";
import { IntelligenceModule } from "./intelligence/intelligence.module";
import { CrmModule } from "./crm/crm.module";
import { RelationshipsModule } from "./relationships/relationships.module";

@Module({
  imports: [
    HealthModule,
    MissionsModule,
    OpportunitiesModule,
    ApprovalsModule,
    TransactionsModule,
    WebhooksModule,
    PublicModule,
    SignalsModule,
    EntitiesModule,
    SettlementModule,
    NegotiationsModule,
    AssetTransferModule,
    SearchModule,
    IntelModule,
    MarketplaceModule,
    AnalyticsModule,
    SourcesModule,
    IntelligenceModule,
    CrmModule,
    RelationshipsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
