import { Module } from "@nestjs/common";
import { getConfig } from "@opportunity-os/config";
import {
  EmailChannel,
  MessageChannelRegistry,
  TelegramChannel,
  TwilioSmsChannel,
  WhatsAppChannel,
} from "./channels";

/**
 * §11 messaging backlog — composed here the same way `settlement/rails.ts`
 * composes `SettlementService`: one place that knows about every channel's
 * config, everything else depends only on `MessageChannelRegistry`. Each
 * channel is a no-op (returns `undefined`) when unconfigured, same
 * keyless-dev pattern as the settlement rails — nothing here throws at
 * startup for a missing provider.
 */
function createMessageChannelRegistry(): MessageChannelRegistry {
  const { notifications } = getConfig();
  const registry = new MessageChannelRegistry();
  registry.register(new TelegramChannel(notifications.telegramBotToken));
  registry.register(new TwilioSmsChannel(notifications.twilioAccountSid, notifications.twilioAuthToken, notifications.twilioFromNumber));
  registry.register(new EmailChannel(notifications.smtpUrl, notifications.emailFrom));
  registry.register(new WhatsAppChannel(notifications.whatsappAccessToken, notifications.whatsappPhoneNumberId));
  return registry;
}

@Module({
  providers: [{ provide: MessageChannelRegistry, useFactory: createMessageChannelRegistry }],
  exports: [MessageChannelRegistry],
})
export class MessagingModule {}
