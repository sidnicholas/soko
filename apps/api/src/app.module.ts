import { Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module";
import { MissionsModule } from "./missions/missions.module";
import { OpportunitiesModule } from "./opportunities/opportunities.module";
import { ApprovalsModule } from "./approvals/approvals.module";
import { TransactionsModule } from "./transactions/transactions.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { PublicModule } from "./public/public.module";
import { SignalsModule } from "./signals/signals.module";
import { EntitiesModule } from "./entities/entities.module";

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
  ],
})
export class AppModule {}
