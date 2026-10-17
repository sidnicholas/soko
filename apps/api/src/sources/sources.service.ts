import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  getSource,
  listSourceReviews,
  listSourceRuns,
  listSources,
  reviewSource,
  setSourceStatus,
  sourceYield,
  SourcePolicyError,
  upsertSubmittedSource,
  type RegistrySource,
  type SourceActor,
} from "@opportunity-os/db";
import { DEFAULT_REVIEW_DAYS, RISK_ACCEPTANCE_MAX_DAYS, SOURCE_POLICY_VERSION, policyGaps, vetSource, type SubmittedSource } from "@opportunity-os/intel";
import type { SourceReviewBody } from "./sources.dto";

const POLICY = { policyGaps: (s: RegistrySource) => policyGaps(s), policyVersion: SOURCE_POLICY_VERSION };

/** One submission's outcome, per side it lists on. */
export interface SubmissionResult {
  source_id: string | null;
  domain: string;
  orientation: string | null;
  outcome: "added" | "already_known" | "rejected";
  status: string;
  reason: string | null;
}

/**
 * Source registry operations (PRD v2 FR-01, ADR-037). Screening and the
 * permission policy are deterministic code in packages/intel; persistence,
 * audit and events are in packages/db. Nothing here lets a submission run
 * before a review.
 */
@Injectable()
export class SourcesService {
  /** Every registered source with its policy gaps and 30-day yield. */
  async list() {
    const [sources, yields] = await Promise.all([listSources(), sourceYield(30)]);
    return sources.map((s) => ({ ...s, policy_gaps: policyGaps(s), yield: yields.get(s.id) ?? null }));
  }

  async detail(id: string) {
    const source = await getSource(id);
    if (!source) throw new NotFoundException(`Source ${id} not found`);
    const [reviews, runs, yields] = await Promise.all([listSourceReviews(id), listSourceRuns(id), sourceYield(30)]);
    return { ...source, policy_gaps: policyGaps(source), yield: yields.get(id) ?? null, reviews, runs };
  }

  /** Screens each submitted source; the ones that pass wait for review as `proposed`. */
  async submit(submitted: SubmittedSource[], actor: SourceActor, origin: string) {
    const results: SubmissionResult[] = [];
    for (const item of submitted) {
      const { vetted, rejected } = vetSource(item);
      if (rejected) {
        results.push({ source_id: item.source_id ?? null, domain: item.domain, orientation: null, outcome: "rejected", status: "rejected", reason: rejected });
        continue;
      }
      for (const v of vetted) {
        const { source, created } = await upsertSubmittedSource({ ...v, origin }, actor);
        // An already-known source keeps its status; report that, not what screening would say today.
        results.push({ source_id: v.externalId, domain: v.domain, orientation: v.orientation, outcome: created ? "added" : "already_known", status: source.status, reason: source.status_reason });
      }
    }
    const added = results.filter((r) => r.outcome === "added");
    return {
      received: submitted.length,
      added: added.length,
      added_proposed: added.filter((r) => r.status === "proposed").length,
      added_paused: added.filter((r) => r.status === "paused").length,
      already_known: results.filter((r) => r.outcome === "already_known").length,
      rejected: results.filter((r) => r.outcome === "rejected").length,
      results,
    };
  }

  /** Records a permission-policy review; approval activates the source only when the policy is then satisfied. */
  async review(id: string, body: SourceReviewBody, reviewer: SourceActor) {
    const risk = body.permission_basis === "owner_risk_acceptance";
    // An owner accepting the risk says what risk, in their own words (ADR-043).
    if (risk && body.decision === "approved" && !body.notes?.trim()) throw new BadRequestException("Accepting the risk needs a note saying what risk is accepted and why");
    const due = body.terms_review_due_at ?? new Date(Date.now() + (risk ? RISK_ACCEPTANCE_MAX_DAYS : DEFAULT_REVIEW_DAYS) * 86_400_000).toISOString();
    const result = await reviewSource({
      sourceId: id,
      decision: body.decision,
      permissionBasis: body.permission_basis,
      robotsTosAssessment: body.robots_tos_assessment ?? null,
      dataUseConstraints: body.data_use_constraints ?? null,
      termsReviewDueAt: due,
      notes: body.notes ?? null,
      reviewer,
      reviewerLabel: null,
      policyVersion: SOURCE_POLICY_VERSION,
      policyGaps: POLICY.policyGaps,
    });
    if (!result) throw new NotFoundException(`Source ${id} not found`);
    return { ...result.source, policy_gaps: result.gaps };
  }

  /** Pause, or resume when the permission policy is satisfied (409 with the gaps otherwise). */
  async setStatus(id: string, status: "active" | "paused", reason: string | null, actor: SourceActor) {
    try {
      const updated = await setSourceStatus(id, status, status === "active" ? null : (reason ?? "paused_by_staff"), actor, POLICY);
      if (!updated) throw new NotFoundException(`Source ${id} not found`);
      return updated;
    } catch (err) {
      if (err instanceof SourcePolicyError) throw new ConflictException({ message: err.message, policy_gaps: err.gaps });
      throw err;
    }
  }
}
