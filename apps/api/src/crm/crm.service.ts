import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { getConfig } from "@opportunity-os/config";
import { abandonCrmLink, applyCrmDealEvent, beginCrmLink, completeCrmLink, getIntelCandidate, listEvidence, type CrmEventOutcome } from "@opportunity-os/db";
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
      return { link: done, created: true };
    } catch (err) {
      // Only before the link is completed; afterwards abandon is a no-op (external_id is set).
      await abandonCrmLink(link.id);
      throw err;
    }
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
