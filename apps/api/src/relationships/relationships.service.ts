import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  RelationshipError,
  addChannel,
  addMemory,
  correctMemory,
  createParty,
  deleteMemory,
  findPartyByChannel,
  getPartyDetail,
  linkParty,
  listParties,
  listPartiesForSubject,
  purgeParty,
  recordConsent,
  removeChannel,
  restoreParty,
  setChannelStatus,
  unlinkParty,
  updateParty,
  type Actor,
  type ChannelStatus,
  type LinkSubject,
  type PartyStatus,
  type PartyType,
} from "@opportunity-os/db";
import { CrmService } from "../crm/crm.service";
import type { ChannelBody, ConsentBody, CreatePartyBody, LinkBody, MemoryBody, UpdatePartyBody } from "./relationships.dto";

/**
 * Contacts, consent and relationship memory (PRD v2 FR-06, ADR-041).
 * Opportunity OS is the system of record; a party linked to a candidate
 * already in Pipedrive is copied there as it changes (best effort: a CRM
 * outage never loses the local change).
 */
@Injectable()
export class RelationshipsService {
  private readonly logger = new Logger(RelationshipsService.name);

  constructor(@Inject(CrmService) private readonly crm: CrmService) {}

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RelationshipError) {
        if (err.code === "not_found") throw new NotFoundException(err.message);
        if (err.code === "memory_not_active") throw new ConflictException(err.message);
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  /** Keeps the Pipedrive copy current for a party already there or on an elevated deal. */
  private async resync(partyId: string, actorId: string | null) {
    if (!this.crm.configured()) return;
    try {
      const detail = await getPartyDetail(partyId);
      if (!detail) return;
      if (detail.crm?.external_id) await this.crm.syncParty(partyId, actorId);
      for (const l of detail.links) if (l.subject_type === "intel_candidate") await this.crm.attachCandidateParties(l.subject_id, actorId);
    } catch (err) {
      this.logger.warn(`pipedrive sync for contact ${partyId} failed: ${String(err)}`);
    }
  }

  list(opts: { status?: PartyStatus; type?: PartyType; q?: string }) {
    return listParties(opts);
  }

  async detail(id: string) {
    const d = await getPartyDetail(id);
    if (!d) throw new NotFoundException("Contact not found");
    return d;
  }

  forSubject(subjectType: LinkSubject, subjectId: string) {
    return listPartiesForSubject(subjectType, subjectId);
  }

  /** Creates a contact; when one of its email or phone channels already belongs to a contact, that contact is returned for the operator to use instead. */
  async create(body: CreatePartyBody, actor: Actor, opts: { allowDuplicate?: boolean } = {}) {
    if (!opts.allowDuplicate) {
      for (const c of body.channels ?? []) {
        if (c.kind !== "email" && c.kind !== "phone") continue;
        const existing = await findPartyByChannel(c.kind, c.value);
        if (existing) throw new ConflictException({ message: `${c.value} already belongs to ${existing.display_name}`, existingId: existing.id });
      }
    }
    const created = await this.run(() => createParty(body, actor));
    if (body.link) await this.resync(created.party.id, actor.id);
    return created;
  }

  async update(id: string, body: UpdatePartyBody, actor: Actor) {
    const d = await this.run(() => updateParty(id, body, actor));
    await this.resync(id, actor.id);
    return d;
  }

  async addChannel(id: string, body: ChannelBody, actor: Actor) {
    const ch = await this.run(() => addChannel(id, body, actor));
    await this.resync(id, actor.id);
    return ch;
  }

  async setChannelStatus(id: string, channelId: string, status: ChannelStatus, actor: Actor) {
    const ch = await this.run(() => setChannelStatus(id, channelId, status, actor));
    await this.resync(id, actor.id);
    return ch;
  }

  async removeChannel(id: string, channelId: string, actor: Actor) {
    await this.run(() => removeChannel(id, channelId, actor));
    await this.resync(id, actor.id);
    return { removed: true };
  }

  recordConsent(id: string, body: ConsentBody, actor: Actor) {
    return this.run(() => recordConsent(id, body, actor));
  }

  addMemory(id: string, body: MemoryBody, actor: Actor) {
    return this.run(() => addMemory(id, body, actor));
  }

  correctMemory(id: string, memoryId: string, body: MemoryBody, actor: Actor) {
    return this.run(() => correctMemory(id, memoryId, body, actor));
  }

  async deleteMemory(id: string, memoryId: string, actor: Actor) {
    await this.run(() => deleteMemory(id, memoryId, actor));
    return { deleted: true };
  }

  async link(id: string, body: LinkBody, actor: Actor) {
    await this.run(() => linkParty(id, body, actor));
    if (body.subjectType === "intel_candidate") await this.resync(id, actor.id);
    return this.detail(id);
  }

  async unlink(id: string, linkId: string, actor: Actor) {
    await this.run(() => unlinkParty(id, linkId, actor));
    return { removed: true };
  }

  async restore(id: string, actor: Actor) {
    await this.run(() => restoreParty(id, actor));
    return this.detail(id);
  }

  /** Copies the contact to Pipedrive now. */
  async syncToCrm(id: string, actorId: string) {
    await this.detail(id);
    return this.crm.syncParty(id, actorId);
  }

  /**
   * Data-subject deletion: everything about the contact is removed, here and
   * in Pipedrive; only hashes of its email and phone remain so it is never
   * contacted again.
   */
  async deleteParty(id: string, confirmName: string, actor: Actor) {
    const d = await this.detail(id);
    if (confirmName.trim().toLowerCase() !== d.party.display_name.trim().toLowerCase()) throw new BadRequestException("Type the contact's name exactly to delete it");
    const result = await purgeParty(id, "dsar_delete", actor);
    let crmDeleted = false;
    let crmError: string | null = null;
    if (result.crmExternalId) {
      try {
        crmDeleted = await this.crm.deletePartyCopy(result.crmExternalId);
      } catch (err) {
        crmError = String(err);
        this.logger.error(`pipedrive delete of ${result.crmExternalId} for purged contact ${id} failed: ${crmError}`);
      }
    }
    return { deleted: result.purged, crm: result.crmExternalId ? { deleted: crmDeleted, error: crmError } : null };
  }
}
