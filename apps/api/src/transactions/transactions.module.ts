import { Module } from "@nestjs/common";
import { TransactionsController } from "./transactions.controller";
import { TransactionService } from "./transaction.service";

@Module({
  controllers: [TransactionsController],
  providers: [TransactionService],
})
export class TransactionsModule {}
