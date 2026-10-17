import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { getConfig } from "@opportunity-os/config";
import { apifyClient, parseFieldMap, parseSearchPlan } from "@opportunity-os/connectors-sdk";
import {
  apifySpendToday,
  dealCheckSummary,
  listRunSearches,
  getApifySource,
  listApifyRuns,
  listQuarantine,
  registerApifySource,
  sourceSpendToday,
  updateApifyConfig,
  type SourceActor,
} from "@opportunity-os/db";
import { QuarantineError, apifyStartDecision, mapQuarantinedCategory, policyGaps, processApifyRun, resolveQuarantinedItem, startApifyRun } from "@opportunity-os/intel";
import { admissibleCategories, isAdmissible } from "@opportunity-os/risk";
import { timingSafeStringEqual } from "../common/webhook-signature";
import type { ApifyConfigBody, ApifySourceBody, QuarantineDecisionBody } from "./apify.dto";

export const APIFY_WEBHOOK_PATH = "/v1/webhooks/apify";

/**
 * Apify sources and ingestion (PRD v2 FR-01, ADR-042): register and configure
 * actors (they still need a policy review to run), start one now, accept the
 * completion webhook, and decide quarantined items.
 */
@Injectable()
export class ApifyService {
  private readonly logger = new Logger(ApifyService.name);

  private client() {
    const token = getConfig().connectors.apify.token;
    if (!token) throw new ServiceUnavailableException("Apify is not configured: set APIFY_API_TOKEN on api");
    return apifyClient({ token });
  }

  private webhook() {
    const { webhookSecret } = getConfig().connectors.apify;
    const base = getConfig().notifications.publicApiBaseUrl;
    return base && webhookSecret ? { url: `${base.replace(/\/$/, "")}${APIFY_WEBHOOK_PATH}`, secret: webhookSecret } : null;
  }

  private fieldMap(v: unknown) {
    const parsed = parseFieldMap(v);
    if ("errors" in parsed) throw new BadRequestException({ message: "Invalid field map", issues: parsed.errors });
    const unknown = Object.values(parsed.map.categoryMap ?? {}).filter((c) => !isAdmissible(c));
    if (unknown.length) throw new BadRequestException({ message: "Invalid field map", issues: [`unknown categories in categoryMap: ${[...new Set(unknown)].join(", ")}`] });
    return parsed.map;
  }

  private searchPlan(v: unknown) {
    if (v === null || v === undefined) return v;
    const parsed = parseSearchPlan(v);
    if ("errors" in parsed) throw new BadRequestException({ message: "Invalid search plan", issues: parsed.errors });
    return parsed.plan;
  }

  status() {
    const a = getConfig().connectors.apify;
    return { configured: Boolean(a.token), webhook: Boolean(this.webhook()), dailyBudgetUsd: a.dailyBudgetUsd, categories: admissibleCategories() };
  }

  async register(body: ApifySourceBody, actor: SourceActor) {
    const source = await registerApifySource(
      {
        name: body.name,
        domain: body.domain,
        orientation: body.orientation,
        notes: body.notes ?? null,
        evidenceUrl: body.evidenceUrl ?? null,
        minIntervalMinutes: body.minIntervalMinutes ?? null,
        maxDailyUsd: body.maxDailyUsd ?? null,
        actorId: body.actorId,
        actorVersion: body.actorVersion,
        input: body.input,
        fieldMap: this.fieldMap(body.fieldMap),
        expectedFields: body.expectedFields ?? null,
        maxItems: body.maxItems ?? null,
        maxChargeUsd: body.maxChargeUsd ?? null,
        searchPlan: this.searchPlan(body.searchPlan) ?? null,
      },
      actor,
    ).catch((err: unknown) => {
      if (String(err).includes("source_registry_kind_domain_orientation")) throw new ConflictException("An Apify source for that domain and side is already registered");
      throw err;
    });
    return { ...source, policy_gaps: policyGaps(source) };
  }

  async configure(id: string, body: ApifyConfigBody, actor: SourceActor) {
    const updated = await updateApifyConfig(
      id,
      { ...body, ...(body.fieldMap !== undefined ? { fieldMap: this.fieldMap(body.fieldMap) } : {}), ...(body.searchPlan !== undefined ? { searchPlan: this.searchPlan(body.searchPlan) } : {}) },
      actor,
    );
    if (!updated) throw new NotFoundException(`Apify source ${id} not found`);
    return { ...updated, policy_gaps: policyGaps(updated) };
  }

  async detail(id: string) {
    const source = await getApifySource(id);
    if (!source) throw new NotFoundException(`Apify source ${id} not found`);
    const [runs, quarantine] = await Promise.all([listApifyRuns(id), listQuarantine({ sourceId: id, limit: 50 })]);
    const [searches, deals] = await Promise.all([runs[0] ? listRunSearches(runs[0].id) : Promise.resolve([]), dealCheckSummary(id)]);
    return {
      config: { input: source.apify_input, fieldMap: source.apify_field_map, expectedFields: source.apify_expected_fields, maxItems: source.apify_max_items, maxChargeUsd: source.apify_max_charge_usd, searchPlan: source.apify_search },
      runs,
      quarantine,
      lastSearches: searches,
      deals,
    };
  }

  /** Starts a run now: every rule applies except the minimum interval. */
  async runNow(id: string) {
    const client = this.client();
    const source = await getApifySource(id);
    if (!source) throw new NotFoundException(`Apify source ${id} not found`);
    const spent = { source: (await sourceSpendToday()).get(id) ?? 0, all: await apifySpendToday() };
    const decision = await apifyStartDecision({ ...source, last_run_at: null }, { client, webhook: this.webhook(), dailyBudgetUsd: getConfig().connectors.apify.dailyBudgetUsd }, spent);
    if ("skip" in decision) throw new ConflictException({ message: `Cannot run now: ${decision.skip.replaceAll("_", " ")}`, reason: decision.skip });
    const started = await startApifyRun(source, { client, webhook: this.webhook(), dailyBudgetUsd: getConfig().connectors.apify.dailyBudgetUsd }, decision.maxChargeUsd);
    if ("skip" in started) throw new ConflictException({ message: `Cannot run now: ${started.skip.replaceAll("_", " ")}`, reason: started.skip });
    return started.run;
  }

  quarantine(status?: "pending" | "released" | "discarded") {
    return listQuarantine({ status });
  }

  async decide(id: string, body: QuarantineDecisionBody, actor: SourceActor) {
    try {
      if (body.decision === "map_category") return await mapQuarantinedCategory(id, body.category!, actor);
      return await resolveQuarantinedItem(id, body.decision, actor, { acceptFields: body.acceptFields });
    } catch (err) {
      if (err instanceof QuarantineError) {
        if (err.code === "invalid_category") throw new BadRequestException("Not a known category");
        if (err.code === "not_found") throw new NotFoundException("Quarantined item not found");
        if (err.code === "not_pending") throw new ConflictException("Already decided");
        if (err.code === "not_releasable") throw new BadRequestException("Only items held for unexpected fields can be released; fix the field map or category mapping and run again");
        throw new BadRequestException("The source's field map is invalid");
      }
      throw err;
    }
  }

  /**
   * Apify's completion call. Apify does not sign webhooks, so the secret
   * header (sent through the run's headersTemplate) authenticates the call and
   * nothing in the body is trusted: the run id is looked up among the runs we
   * started and its state is read back from Apify.
   */
  async handleWebhook(secret: string | undefined, body: unknown) {
    const expected = getConfig().connectors.apify.webhookSecret;
    if (!expected || !secret || !timingSafeStringEqual(secret, expected)) throw new UnauthorizedException("Invalid Apify webhook secret");
    const b = body as { eventData?: { actorRunId?: unknown }; resource?: { id?: unknown } } | null;
    const runId = b?.eventData?.actorRunId ?? b?.resource?.id;
    if (typeof runId !== "string" || !runId) return { received: true, outcome: "ignored" as const };
    const result = await processApifyRun(runId, this.client());
    this.logger.log(`apify run ${runId}: ${result.outcome}${result.counts ? ` ${JSON.stringify(result.counts)}` : ""}`);
    return { received: true, outcome: result.outcome };
  }
}
