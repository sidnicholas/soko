import { Body, Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";
import {
  ApproveSchema,
  ConversationStatusSchema,
  DraftSchema,
  EditDraftSchema,
  ResolveSchema,
  type ApproveBody,
  type ConversationStatusBody,
  type DraftBody,
  type EditDraftBody,
  type ResolveBody,
} from "./outreach.dto";
import { OutreachService } from "./outreach.service";

const actor = (user: Principal) => ({ type: "user" as const, id: user.userId });

/**
 * Email outreach (PRD v2 FR-07, ADR-045). Staff read; operators draft,
 * review replies and handle exceptions; only outreach:send approves a
 * message for sending (never agents).
 */
@ApiTags("outreach")
@Controller("outreach")
export class OutreachController {
  constructor(@Inject(OutreachService) private readonly outreach: OutreachService) {}

  @Get("status")
  @ApiOperation({ summary: "Whether sending is set up, the daily cap and today's count, the sending window" })
  status(@CurrentUser() user: Principal) {
    requirePermission(user, "opportunity:reverify");
    return this.outreach.status();
  }

  @Get("inbox")
  @ApiOperation({ summary: "Drafts, queued, replies needing review, awaiting response, exceptions" })
  inbox(@CurrentUser() user: Principal) {
    requirePermission(user, "opportunity:reverify");
    return this.outreach.inbox();
  }

  @Get("conversations/:id")
  @ApiOperation({ summary: "A conversation with every message" })
  conversation(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string) {
    requirePermission(user, "opportunity:reverify");
    return this.outreach.conversation(id);
  }

  @Post("conversations/:id/status")
  @ApiOperation({ summary: "Close or reopen a conversation" })
  setStatus(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(ConversationStatusSchema) body: ConversationStatusBody) {
    requirePermission(user, "outcome:record");
    return this.outreach.setStatus(id, body.status, actor(user));
  }

  @Get("parties/:id")
  @ApiOperation({ summary: "A contact's conversations, and whether an address may be emailed" })
  forParty(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @Query("address") address?: string) {
    requirePermission(user, "opportunity:reverify");
    return this.outreach.forParty(id, address);
  }

  @Post("drafts")
  @ApiOperation({ summary: "Write a draft (new conversation, or a reply in one)" })
  draft(@CurrentUser() user: Principal, @ZodBody(DraftSchema) body: DraftBody) {
    requirePermission(user, "outcome:record");
    return this.outreach.draft(body, actor(user));
  }

  @Get("messages/:id")
  @ApiOperation({ summary: "A message, with the content hash an approval must quote" })
  message(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string) {
    requirePermission(user, "opportunity:reverify");
    return this.outreach.message(id);
  }

  @Patch("messages/:id")
  @ApiOperation({ summary: "Edit a draft" })
  edit(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(EditDraftSchema) body: EditDraftBody) {
    requirePermission(user, "outcome:record");
    return this.outreach.edit(id, body, actor(user));
  }

  @Post("messages/:id/approve")
  @ApiOperation({ summary: "Approve this exact message for sending (consent, caps and window apply)" })
  approve(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(ApproveSchema) body: ApproveBody) {
    requirePermission(user, "outreach:send");
    return this.outreach.approve(id, body, actor(user));
  }

  @Post("messages/:id/cancel")
  @ApiOperation({ summary: "Cancel a draft or queued message" })
  cancel(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string) {
    requirePermission(user, "outcome:record");
    return this.outreach.cancel(id, actor(user));
  }

  @Post("messages/:id/review")
  @ApiOperation({ summary: "Mark a reply as read" })
  review(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string) {
    requirePermission(user, "outcome:record");
    return this.outreach.review(id, actor(user));
  }

  @Post("messages/:id/resolve")
  @ApiOperation({ summary: "Handle an exception: a stuck send was sent or failed, a bounce or failure seen" })
  resolve(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(ResolveSchema) body: ResolveBody) {
    requirePermission(user, "outcome:record");
    return this.outreach.resolve(id, body.outcome, actor(user));
  }
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}</style></head><body>${body}</body></html>`;

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The unsubscribe link in every message (CAN-SPAM) and the one-click
 * List-Unsubscribe-Post header (RFC 8058). Opening the link only shows a
 * button, so mail scanners that follow links do not unsubscribe anyone; the
 * POST opts out. Authenticated by the signed token, not a session.
 */
@ApiTags("outreach")
@Controller("outreach/unsubscribe")
export class UnsubscribeController {
  constructor(@Inject(OutreachService) private readonly outreach: OutreachService) {}

  @Get()
  @Header("content-type", "text/html; charset=utf-8")
  @ApiOperation({ summary: "Unsubscribe page (confirm button)" })
  form(@Query("t") token?: string) {
    if (!token) return page("Unsubscribe", "<p>This link is incomplete.</p>");
    return page(
      "Unsubscribe",
      `<h1>Unsubscribe</h1><p>Stop all email from us to this address?</p><form method="post" action="?t=${escapeAttr(encodeURIComponent(token))}"><button type="submit">Unsubscribe</button></form>`,
    );
  }

  @Post()
  @HttpCode(200)
  @Header("content-type", "text/html; charset=utf-8")
  @ApiOperation({ summary: "Unsubscribe (link form or one-click header)" })
  async confirm(@Query("t") token?: string, @Body() _body?: unknown) {
    const ok = await this.outreach.unsubscribe(token);
    return ok ? page("Unsubscribed", "<h1>You're unsubscribed</h1><p>You won't receive any more email from us.</p>") : page("Unsubscribe", "<p>This link is not valid. Reply to the email with \"unsubscribe\" instead.</p>");
  }
}
