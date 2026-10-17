import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { getConfig } from "@opportunity-os/config";
import {
  abandonCrmLink,
  applyCrmDealEvent,
  beginCrmLink,
  completeCrmLink,
  crmPartyRef,
  getCrmLink,
  getIntelCandidate,
  getPartyDetail,
  listEvidence,
  listPartiesForSubject,
  saveCrmPartyLink,
  type CrmEventOutcome,
} from "@opportunity-os/db";
import { timingSafeStringEqual } from "../common/webhook-signature";
import { dealNoteHtml, parsePipedriveDealEvent, pipedriveClient } from "./pipedrive";

export const PIPEDRIVE_WEBHOOK_PATH = "/v1/webhooks/pipedrive";

/** The deal value Pipedrive shows: the middle of the net profit range, never below zero. */
function dealValue(economics: unknown): number | null {
  const deal = (economics as { deal?: { netProfitUsd?: unknown } } | null)?.deal;
  const net = deal?.netProfitUsd;
  if (!Array.isArray(net) || net.length !== 2) return null;
  return Math.max(0, Math.round(((Number(net[0]) + Number(net[1])) / 2) * 100) / 100);
}

function expectedClose(economics: unknown): string | null {
  const days = (economics as { deal?: { daysToCash?: unknown } } | null)?.deal?.daysToCash;
  if (!Array.isArray(days) || days.length !== 2) return null;
  const mid = (Number(days[0]) + Number(days[1])) / 2;
  return Number.isFinite(mid) ? new Date(Date.now() + mid * 86_400_000).toISOString().slice(0, 10) : null;
}

/**
 * Pipedrive (ADR-040): elevate an Action Queue candidate to a Pipedrive deal,
 * register the webhook, and apply what Pipedrive reports back.
 */
@Injectable()
export class CrmService {
  private readonly logger = new Logger(CrmService.name);

  private client() {
    const p = getConfig().crm.pipedrive;
    if (!p.companyDomain || !p.apiToken) throw new ServiceUnavailableException("Pipedrive is not configured: set PIPEDRIVE_COMPANY_DOMAIN and PIPEDRIVE_API_TOKEN on api");
    return { pd: pipedriveClient({ companyDomain: p.companyDomain, apiToken: p.apiToken }), cfg: p };
  }

  async elevateCandidate(candidateId: string, actorId: string) {
    const { pd, cfg } = this.client();
    const c = await getIntelCandidate(candidateId);
    if (!c) throw new NotFoundException(`Candidate ${candidateId} not found`);
    const { link, existing } = await beginCrmLink("pipedrive", "intel_candidate", candidateId, actorId);
    if (existing) {
      if (link.external_id) return { link, created: false };
      throw new ConflictException("This candidate is being sent to Pipedrive already; try again in a few minutes if it does not appear");
    }
    try {
      const deal = await pd.createDeal({
        title: c.title,
        value: dealValue(c.economics),
        currency: "USD",
        ...(cfg.pipelineId ? { pipelineId: cfg.pipelineId } : {}),
        ...(cfg.stageId ? { stageId: cfg.stageId } : {}),
        expectedCloseDate: expectedClose(c.economics),
      });
      // Link first, so the deal's own webhook events (which follow within a
      // second) find it; then the note, which is best-effort.
      const done = await completeCrmLink(
        link.id,
        { externalId: String(deal.id), externalUrl: pd.dealUrl(deal.id), status: deal.status === "won" || deal.status === "lost" ? deal.status : "open", stageId: deal.stage_id ?? null, value: deal.value ?? null, currency: deal.currency ?? "USD" },
        actorId,
      );
      const [leadEvidence, candidateEvidence] = await Promise.all([listEvidence("intel_lead", c.lead_id), listEvidence("intel_candidate", c.id)]);
      const web = getConfig().auth.webOrigins[0];
      await pd.addNote(deal.id, dealNoteHtml(c as never, [...leadEvidence, ...candidateEvidence], web ? `${web.replace(/\/$/, "")}/queue` : null)).catch((err) => this.logger.warn(`pipedrive note for deal ${deal.id} failed: ${String(err)}`));
      await this.attachCandidateParties(candidateId, actorId).catch((err) => this.logger.warn(`pipedrive contacts for deal ${deal.id} failed: ${String(err)}`));
      return { link: done, created: true };
    } catch (err) {
      // Only before the link is completed; afterwards abandon is a no-op (external_id is set).
      await abandonCrmLink(link.id);
      throw err;
    }
  }

  /** Whether Pipedrive is configured, so contact changes can be copied without failing the request. */
  configured(): boolean {
    const p = getConfig().crm.pipedrive;
    return Boolean(p.companyDomain && p.apiToken);
  }

  /**
   * Copies a party to Pipedrive (ADR-041): an organization, or a person with
   * its organization copied first. Opportunity OS stays the record; the copy
   * is created once and updated after.
   */
  async syncParty(partyId: string, actorId: string | null): Promise<{ kind: "person" | "org"; id: number; url: string }> {
    const { pd } = this.client();
    const detail = await getPartyDetail(partyId);
    if (!detail) throw new NotFoundException("Contact not found");
    const existing = crmPartyRef((await getCrmLink("pipedrive", "counterparty", partyId))?.external_id ?? null);
    const { party, channels } = detail;
    let remote: { kind: "person" | "org"; id: number; url: string };
    if (party.type === "organization") {
      const org = await pd.upsertOrganization({ name: party.display_name }, existing?.kind === "org" ? existing.id : undefined);
      remote = { kind: "org", id: org.id, url: pd.organizationUrl(org.id) };
    } else {
      const orgId = party.organization_id ? (await this.syncParty(party.organization_id, actorId)).id : null;
      const live = channels.filter((ch) => ch.status === "active");
      const person = await pd.upsertPerson(
        { name: party.display_name, orgId, emails: live.filter((ch) => ch.kind === "email").map((ch) => ch.value), phones: live.filter((ch) => ch.kind === "phone").map((ch) => ch.value) },
        existing?.kind === "person" ? existing.id : undefined,
      );
      remote = { kind: "person", id: person.id, url: pd.personUrl(person.id) };
    }
    await saveCrmPartyLink("pipedrive", partyId, remote, actorId);
    return remote;
  }

  /**
   * Puts a candidate's contacts on its Pipedrive deal: each is copied, and the
   * deal gets the first person and the first organization (or that person's).
   * A no-op while the candidate has no deal.
   */
  async attachCandidateParties(candidateId: string, actorId: string | null): Promise<{ attached: boolean }> {
    const deal = await getCrmLink("pipedrive", "intel_candidate", candidateId);
    if (!deal?.external_id || !this.configured()) return { attached: false };
    const parties = await listPartiesForSubject("intel_candidate", candidateId);
    if (parties.length === 0) return { attached: false };
    const synced = [];
    for (const p of parties) synced.push({ party: p, remote: await this.syncParty(p.id, actorId) });
    const person = synced.find((x) => x.remote.kind === "person");
    let orgId = synced.find((x) => x.remote.kind === "org")?.remote.id ?? null;
    if (!orgId && person?.party.organization_id) orgId = crmPartyRef((await getCrmLink("pipedrive", "counterparty", person.party.organization_id))?.external_id ?? null)?.id ?? null;
    await this.client().pd.setDealParties(Number(deal.external_id), { personId: person?.remote.id ?? null, orgId });
    return { attached: true };
  }

  /** Removes a deleted party's Pipedrive copy (data-subject deletion reaches the CRM too). */
  async deletePartyCopy(externalId: string | null): Promise<boolean> {
    const ref = crmPartyRef(externalId);
    if (!ref || !this.configured()) return false;
    await this.client().pd.deleteContact(ref.kind, ref.id);
    return true;
  }

  /** Whether Pipedrive is configured and our webhook is registered there. */
  async status() {
    const p = getConfig().crm.pipedrive;
    const base = getConfig().notifications.publicApiBaseUrl;
    const configured = Boolean(p.companyDomain && p.apiToken);
    const webhookAuth = Boolean(p.webhookUser && p.webhookPassword);
    let webhookRegistered: boolean | null = null;
    if (configured && base) {
      const url = `${base.replace(/\/$/, "")}${PIPEDRIVE_WEBHOOK_PATH}`;
      webhookRegistered = (await this.client().pd.listWebhooks().catch(() => [])).some((w) => w.subscription_url === url);
    }
    return { configured, webhookAuth, webhookRegistered, companyDomain: p.companyDomain ?? null };
  }

  /** Registers our webhook in Pipedrive (deal events, v2, basic auth). Idempotent. */
  async registerWebhook() {
    const { pd, cfg } = this.client();
    const base = getConfig().notifications.publicApiBaseUrl;
    if (!base) throw new ServiceUnavailableException("PUBLIC_API_BASE_URL is not set on api");
    if (!cfg.webhookUser || !cfg.webhookPassword) throw new ServiceUnavailableException("Set PIPEDRIVE_WEBHOOK_USER and PIPEDRIVE_WEBHOOK_PASSWORD on api first");
    const url = `${base.replace(/\/$/, "")}${PIPEDRIVE_WEBHOOK_PATH}`;
    const existing = (await pd.listWebhooks()).find((w) => w.subscription_url === url);
    if (existing) return { registered: true, created: false, id: existing.id };
    const created = await pd.registerWebhook({ url, user: cfg.webhookUser, password: cfg.webhookPassword });
    return { registered: true, created: true, id: created.id };
  }

  /** A Pipedrive delivery: basic auth checked, then the deal event applied once. Always fast; never throws on content. */
  async handleWebhook(authorization: string | undefined, body: unknown): Promise<{ received: true; outcome: CrmEventOutcome | "ignored" }> {
    const { webhookUser, webhookPassword } = getConfig().crm.pipedrive;
    const [scheme, encoded] = (authorization ?? "").split(" ");
    const [user, ...rest] = scheme?.toLowerCase() === "basic" && encoded ? Buffer.from(encoded, "base64").toString("utf8").split(":") : [];
    const password = rest.join(":");
    if (!webhookUser || !webhookPassword || !user || !timingSafeStringEqual(user, webhookUser) || !timingSafeStringEqual(password, webhookPassword)) {
      throw new UnauthorizedException("Invalid Pipedrive webhook credentials");
    }
    const event = parsePipedriveDealEvent(body);
    if (!event) return { received: true, outcome: "ignored" };
    const outcome = await applyCrmDealEvent(event);
    this.logger.log(`pipedrive ${event.action} deal ${event.entityId} (event ${event.eventId}): ${outcome}`);
    // Pipedrive redelivers after 3, 30 and 150 s; by then the link is saved.
    if (outcome === "retry_later") throw new ServiceUnavailableException("Deal is still being linked; redeliver");
    return { received: true, outcome };
  }
}
