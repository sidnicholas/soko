import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  OutreachError,
  approveMessage,
  cancelMessage,
  createDraft,
  getConversation,
  getMessage,
  listConversationsForParty,
  markInboundReviewed,
  outreachBlockReason,
  outreachInbox,
  resolveException,
  setConversationStatus,
  unsubscribeByMessageId,
  updateDraft,
  type Actor,
} from "@opportunity-os/db";
import { getConfig } from "@opportunity-os/config";
import { outreachMissing, outreachSettings, sendDue, smtpSender } from "@opportunity-os/outreach";
import { verifyUnsubscribe, withinSendWindow } from "@opportunity-os/relationship";
import type { ApproveBody, DraftBody, EditDraftBody } from "./outreach.dto";

/**
 * Approval-first email outreach (PRD v2 FR-07, ADR-045). Drafts are written
 * by staff; only outreach:send approves one, and the approval covers the
 * exact recipient, subject and body shown. An approved message goes out at
 * once when the window and caps allow, else on the next worker sweep.
 */
@Injectable()
export class OutreachService {
  private readonly logger = new Logger(OutreachService.name);

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof OutreachError) {
        if (err.code === "not_found") throw new NotFoundException(err.message);
        if (err.code === "invalid") throw new BadRequestException(err.message);
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }

  async status() {
    const o = getConfig().outreach;
    const inbox = await outreachInbox();
    return {
      configured: outreachMissing().length === 0,
      missing: outreachMissing(),
      address: o.address ?? null,
      dailyCap: o.dailyCap,
      sentLast24h: inbox.sentLast24h,
      minGapHours: o.minGapHours,
      window: { ...o.sendHours, timezone: o.timezone, weekends: o.weekends },
      inWindow: withinSendWindow(new Date(), { ...o.sendHours, timezone: o.timezone, weekends: o.weekends }),
    };
  }

  inbox() {
    return outreachInbox();
  }

  async conversation(id: string) {
    const c = await getConversation(id);
    if (!c) throw new NotFoundException("Conversation not found");
    return c;
  }

  async message(id: string) {
    const m = await getMessage(id);
    if (!m) throw new NotFoundException("Message not found");
    return m;
  }

  async forParty(partyId: string, address?: string) {
    return { conversations: await listConversationsForParty(partyId), blocked: address ? await outreachBlockReason(partyId, address) : null };
  }

  draft(body: DraftBody, actor: Actor) {
    return this.run(() => createDraft(body, actor));
  }

  async edit(id: string, body: EditDraftBody, actor: Actor) {
    await this.run(() => updateDraft(id, body, actor));
    return this.message(id);
  }

  async approve(id: string, body: ApproveBody, actor: Actor) {
    if (outreachMissing().length) throw new ConflictException(`Email sending is not set up: ${outreachMissing().join(", ")}`);
    await this.run(() => approveMessage(id, body.contentHash, actor));
    const s = outreachSettings();
    if (s) {
      try {
        await sendDue(s, smtpSender(s.mailbox, s.fromName, (err) => this.logger.warn(`sent copy failed: ${String(err)}`)), { max: 3 });
      } catch (err) {
        // Stays queued; the worker sweep sends it.
        this.logger.warn(`immediate send failed: ${String(err)}`);
      }
    }
    return this.message(id);
  }

  async cancel(id: string, actor: Actor) {
    await this.run(() => cancelMessage(id, actor));
    return this.message(id);
  }

  async review(id: string, actor: Actor) {
    await markInboundReviewed(id, actor);
    return { ok: true };
  }

  async resolve(id: string, outcome: "sent" | "failed" | "seen", actor: Actor) {
    await this.run(() => resolveException(id, actor, outcome));
    return { ok: true };
  }

  async setStatus(id: string, status: "open" | "closed", actor: Actor) {
    await this.run(() => setConversationStatus(id, status, actor));
    return { ok: true };
  }

  /** Opts out whoever received the message named by the token. False when the token is not valid. */
  async unsubscribe(token: string | undefined): Promise<boolean> {
    const messageId = token ? verifyUnsubscribe(getConfig().security.approvalTokenSecret, token) : null;
    if (!messageId) return false;
    await unsubscribeByMessageId(messageId);
    return true;
  }
}
