import { Module } from "@nestjs/common";
import { EntitiesController } from "./entities.controller";
import { EntityService } from "./entity.service";

@Module({ controllers: [EntitiesController], providers: [EntityService] })
export class EntitiesModule {}
