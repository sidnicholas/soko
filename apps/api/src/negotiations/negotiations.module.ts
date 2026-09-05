import { Module } from "@nestjs/common";
import { MessagingModule } from "../messaging/messaging.module";
import { NegotiationsController } from "./negotiations.controller";
import { NegotiationService } from "./negotiation.service";

@Module({ imports: [MessagingModule], controllers: [NegotiationsController], providers: [NegotiationService] })
export class NegotiationsModule {}
