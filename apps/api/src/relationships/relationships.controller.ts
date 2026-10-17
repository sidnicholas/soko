import { Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody, ZodValidationPipe } from "../common/zod-validation.pipe";
import { RelationshipsService } from "./relationships.service";
import {
  ChannelSchema,
  ChannelStatusSchema,
  ConsentSchema,
  CreatePartySchema,
  DeletePartySchema,
  LinkSchema,
  ListQuerySchema,
  MemorySchema,
  UpdatePartySchema,
  type ChannelBody,
  type ConsentBody,
  type CreatePartyBody,
  type LinkBody,
  type MemoryBody,
  type UpdatePartyBody,
} from "./relationships.dto";

const SUBJECTS = ["intel_lead", "intel_candidate", "opportunity", "offnetwork_match"] as const;

/**
 * Contacts and organizations, their channels, consent and memory (PRD v2
 * FR-06, ADR-041). Reading is staff work; changing is an operator's (agents
 * never record consent); deleting a contact outright is a separate permission.
 */
@ApiTags("relationships")
@Controller("relationships")
export class RelationshipsController {
  constructor(@Inject(RelationshipsService) private readonly svc: RelationshipsService) {}

  private actor(user: Principal) {
    return { type: "user" as const, id: user.userId };
  }

  @Get()
  @ApiOperation({ summary: "Contacts and organizations, most recently active first (active or archived)" })
  async list(@CurrentUser() user: Principal, @Query(new ZodValidationPipe(ListQuerySchema)) query: z.infer<typeof ListQuerySchema>) {
    requirePermission(user, "opportunity:reverify");
    return this.svc.list(query);
  }

  @Post()
  @ApiOperation({ summary: "Create a contact or organization, optionally with channels and a link to a lead, candidate or deal" })
  async create(@CurrentUser() user: Principal, @ZodBody(CreatePartySchema) body: CreatePartyBody, @Query("allowDuplicate") allowDuplicate?: string) {
    requirePermission(user, "outcome:record");
    return this.svc.create(body, this.actor(user), { allowDuplicate: allowDuplicate === "true" });
  }

  @Get("subjects/:type/:id")
  @ApiOperation({ summary: "The contacts linked to a lead, candidate or deal" })
  async forSubject(@CurrentUser() user: Principal, @Param("type") type: string, @Param("id", ParseUUIDPipe) id: string) {
    requirePermission(user, "opportunity:reverify");
    const subject = SUBJECTS.find((s) => s === type);
    if (!subject) return [];
    return this.svc.forSubject(subject, id);
  }

  @Get(":id")
  @ApiOperation({ summary: "One contact: channels, consent history and what is in force, memories, links, Pipedrive copy" })
  async detail(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string) {
    requirePermission(user, "opportunity:reverify");
    return this.svc.detail(id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit a contact's details" })
  async update(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(UpdatePartySchema) body: UpdatePartyBody) {
    requirePermission(user, "outcome:record");
    return this.svc.update(id, body, this.actor(user));
  }

  @Post(":id/delete")
  @ApiOperation({ summary: "Delete a contact and everything about it, here and in Pipedrive (data-subject request). Its email and phone stay suppressed" })
  async remove(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(DeletePartySchema) body: z.infer<typeof DeletePartySchema>) {
    requirePermission(user, "contact:delete");
    return this.svc.deleteParty(id, body.confirmName, this.actor(user));
  }

  @Post(":id/restore")
  @ApiOperation({ summary: "Bring an archived contact back to active" })
  async restore(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string) {
    requirePermission(user, "outcome:record");
    return this.svc.restore(id, this.actor(user));
  }

  @Post(":id/crm")
  @ApiOperation({ summary: "Copy the contact to Pipedrive now (created once, updated after)" })
  async sync(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string) {
    requirePermission(user, "outcome:record");
    return this.svc.syncToCrm(id, user.userId);
  }

  @Post(":id/channels")
  @ApiOperation({ summary: "Add an email, phone, website or profile" })
  async addChannel(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(ChannelSchema) body: ChannelBody) {
    requirePermission(user, "outcome:record");
    return this.svc.addChannel(id, body, this.actor(user));
  }

  @Patch(":id/channels/:channelId")
  @ApiOperation({ summary: "Mark a channel active (verified), invalid or bounced" })
  async channelStatus(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @Param("channelId", ParseUUIDPipe) channelId: string, @ZodBody(ChannelStatusSchema) body: z.infer<typeof ChannelStatusSchema>) {
    requirePermission(user, "outcome:record");
    return this.svc.setChannelStatus(id, channelId, body.status, this.actor(user));
  }

  @Delete(":id/channels/:channelId")
  @ApiOperation({ summary: "Remove a channel (an opted-out one stays suppressed)" })
  async removeChannel(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @Param("channelId", ParseUUIDPipe) channelId: string) {
    requirePermission(user, "outcome:record");
    return this.svc.removeChannel(id, channelId, this.actor(user));
  }

  @Post(":id/consents")
  @ApiOperation({ summary: "Record consent, a refusal or an opt-out (appended; history is kept)" })
  async consent(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(ConsentSchema) body: ConsentBody) {
    requirePermission(user, "outcome:record");
    return this.svc.recordConsent(id, body, this.actor(user));
  }

  @Post(":id/memories")
  @ApiOperation({ summary: "Record a fact, preference, commitment, objection or other memory, with its source and confidence" })
  async addMemory(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(MemorySchema) body: MemoryBody) {
    requirePermission(user, "outcome:record");
    return this.svc.addMemory(id, body, this.actor(user));
  }

  @Post(":id/memories/:memoryId/correct")
  @ApiOperation({ summary: "Correct a memory: the correction replaces it, the old one is kept as history" })
  async correctMemory(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @Param("memoryId", ParseUUIDPipe) memoryId: string, @ZodBody(MemorySchema) body: MemoryBody) {
    requirePermission(user, "outcome:record");
    return this.svc.correctMemory(id, memoryId, body, this.actor(user));
  }

  @Delete(":id/memories/:memoryId")
  @ApiOperation({ summary: "Delete a memory and its earlier versions (content removed)" })
  async deleteMemory(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @Param("memoryId", ParseUUIDPipe) memoryId: string) {
    requirePermission(user, "outcome:record");
    return this.svc.deleteMemory(id, memoryId, this.actor(user));
  }

  @Post(":id/links")
  @ApiOperation({ summary: "Link the contact to a lead, candidate or deal, in a role" })
  async link(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(LinkSchema) body: LinkBody) {
    requirePermission(user, "outcome:record");
    return this.svc.link(id, body, this.actor(user));
  }

  @Delete(":id/links/:linkId")
  @ApiOperation({ summary: "Remove a link" })
  async unlink(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @Param("linkId", ParseUUIDPipe) linkId: string) {
    requirePermission(user, "outcome:record");
    return this.svc.unlink(id, linkId, this.actor(user));
  }
}
