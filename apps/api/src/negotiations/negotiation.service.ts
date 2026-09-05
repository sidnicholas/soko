import { BadGatewayException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { getApprovalById, getNegotiation, sendNegotiation } from "@opportunity-os/db";
import { verifyApprovalToken } from "@opportunity-os/auth";
import { getConfig } from "@opportunity-os/config";
import { hashNegotiationSendTerms } from "@opportunity-os/audit";
import { assertTransition, InvalidTransitionError, NEGOTIATION_TRANSITIONS } from "@opportunity-os/domain";
import type { NegotiationState } from "@opportunity-os/contracts";
import type { Principal } from "../common/current-user";
import { MessageChannelRegistry } from "../messaging/channels";
import type { SendNegotiationBody } from "./negotiation.dto";

@Injectable()
export class NegotiationService {
  constructor(@Inject(MessageChannelRegistry) private readonly channels: MessageChannelRegistry) {}

  /**
   * §14/§13.5 negotiation:send — always gated (no auto/threshold branch the
   * way settlement release has): the token binds this exact message text to
   * this exact channel+identity (`hashNegotiationSendTerms`), so approving a
   * send approves *this wording, to this destination* — not open-ended
   * permission to negotiate freely. See project memory §11 for what this
   * does and doesn't enable (identity resolution, 2-way threading).
   */
  async send(principal: Principal, token: string | undefined, negotiationId: string, body: SendNegotiationBody) {
    const negotiation = await getNegotiation(negotiationId);
    if (!negotiation) throw new NotFoundException(`Negotiation ${negotiationId} not found`);

    // Fail fast on an invalid transition before dispatching anything — a
    // negotiation already accepted/rejected/expired has nothing left to send.
    try {
      assertTransition("negotiation", NEGOTIATION_TRANSITIONS, negotiation.state as NegotiationState, "proposed");
    } catch (err) {
      if (err instanceof InvalidTransitionError) throw new ConflictException(err.message);
      throw err;
    }

    const payloadHash = hashNegotiationSendTerms({ negotiationId, channel: body.channel, identity: body.identity, text: body.text });
    const verified = verifyApprovalToken(getConfig().security.approvalTokenSecret, token ?? "", {
      action: "send_negotiation",
      payloadHash,
    });
    if (!verified.ok) throw new ForbiddenException(`Approval token invalid: ${verified.reason}`);

    const approval = await getApprovalById(verified.claims!.approvalId);
    if (!approval || (approval.status !== "approved" && approval.status !== "modified")) {
      throw new ForbiddenException("Approval is not in an approved state");
    }
    if (approval.entity_id !== negotiationId) {
      throw new ForbiddenException("Approval does not match the target negotiation");
    }

    let externalRef: string | undefined;
    try {
      externalRef = await this.channels.send(body.channel, body.identity, body.text);
    } catch (err) {
      throw new BadGatewayException(`Dispatch failed on channel ${body.channel}: ${String(err)}`);
    }

    return sendNegotiation({
      negotiationId,
      channel: body.channel,
      identity: body.identity,
      text: body.text,
      externalRef,
      decidedBy: principal.userId,
      termsHash: payloadHash,
    });
  }
}
