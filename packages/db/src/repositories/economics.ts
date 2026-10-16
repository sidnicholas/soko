import { createHash, randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";
import type { Database } from "../schema";
import { candidateValues, type NewIntelCandidate } from "./intel";

/**
 * Evidence and versioned economics (migration 0027, PRD v2 FR-04, ADR-039).
 * Evidence rows are snapshots with a content hash, so a decision's basis can
 * be reproduced; economics versions are append-only, numbered per subject.
 */

const json = (v: unknown) => JSON.stringify(v ?? null);

export type EvidenceSubject = "intel_lead" | "intel_candidate" | "opportunity";
export type EvidenceKind = "source_page" | "counterpart" | "fact" | "contact" | "price_observation";
export type EvidenceLabel = "source_fact" | "inference" | "estimate" | "unknown";

export interface EvidenceInput {
  kind: EvidenceKind;
  url?: string | null;
  title?: string | null;
  excerpt?: string | null;
  label: EvidenceLabel;
  observedAt?: string | null;
}

export function evidenceHash(e: EvidenceInput): string {
  return createHash("sha256")
    .update([e.kind, e.url ?? "", e.title ?? "", e.excerpt ?? ""].join("\u0000"), "utf8")
    .digest("hex");
}

const LABELS: readonly EvidenceLabel[] = ["source_fact", "inference", "estimate", "unknown"];

/** A lead's labelled facts as evidence rows ("field: value", with the model's label). */
export function factEvidence(facts: unknown): EvidenceInput[] {
  if (!Array.isArray(facts)) return [];
  return facts
    .filter((f): f is { field: unknown; value: unknown; label: unknown } => !!f && typeof f === "object")
    .slice(0, 12)
    .map((f) => ({ kind: "fact" as const, excerpt: `${String(f.field)}: ${String(f.value)}`.slice(0, 500), label: LABELS.includes(f.label as EvidenceLabel) ? (f.label as EvidenceLabel) : "unknown" }));
}

/** Stores evidence rows; an identical row for the same subject is stored once. */
export async function insertEvidence(tx: Transaction<Database>, subjectType: EvidenceSubject, subjectId: string, rows: EvidenceInput[]): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .insertInto("opportunity_evidence")
    .values(
      rows.map((e) => ({
        subject_type: subjectType,
        subject_id: subjectId,
        kind: e.kind,
        url: e.url ?? null,
        title: e.title ? e.title.slice(0, 500) : null,
        excerpt: e.excerpt ? e.excerpt.slice(0, 2000) : null,
        label: e.label,
        observed_at: e.observedAt ?? null,
        content_hash: evidenceHash(e),
      })),
    )
    .onConflict((oc) => oc.columns(["subject_type", "subject_id", "kind", "content_hash"]).doNothing())
    .execute();
}

export interface EconomicsRecord {
  modelVersion: string;
  mode: "brokerage" | "principal" | "service";
  inputs: unknown;
  outputs: unknown;
  netProfitUsd: [number, number];
  expectedProfitUsd: [number, number];
  tier: string;
  gates: string[];
}

/**
 * Stores an assessed candidate, a new economics version for it, the evidence
 * it rests on, and opportunity.economics_updated.v1 — one transaction.
 */
export async function recordAssessedCandidate(c: NewIntelCandidate, economics: EconomicsRecord, evidence: EvidenceInput[]): Promise<{ candidateId: string; version: number }> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const values = candidateValues(c);
      const row = await tx
        .insertInto("intel_candidates")
        .values(values)
        .onConflict((oc) => oc.columns(["lead_id", "match_kind"]).doUpdateSet({ ...values, updated_at: sql`now()` }))
        .returning("id")
        .executeTakeFirstOrThrow();
      // Serialize version numbering per subject.
      await sql`select pg_advisory_xact_lock(hashtext(${`intel_candidate:${row.id}`}))`.execute(tx);
      const last = await tx
        .selectFrom("opportunity_economics_versions")
        .select(sql<number>`coalesce(max(version), 0)::int`.as("v"))
        .where("subject_type", "=", "intel_candidate")
        .where("subject_id", "=", row.id)
        .executeTakeFirstOrThrow();
      const version = last.v + 1;
      await tx
        .insertInto("opportunity_economics_versions")
        .values({
          subject_type: "intel_candidate",
          subject_id: row.id,
          version,
          model_version: economics.modelVersion,
          mode: economics.mode,
          inputs: json(economics.inputs),
          outputs: json(economics.outputs),
          net_low_usd: economics.netProfitUsd[0].toFixed(2),
          net_high_usd: economics.netProfitUsd[1].toFixed(2),
          expected_mid_usd: ((economics.expectedProfitUsd[0] + economics.expectedProfitUsd[1]) / 2).toFixed(2),
          tier: economics.tier,
          gates: json(economics.gates),
        })
        .execute();
      await insertEvidence(tx, "intel_candidate", row.id, evidence);
      await enqueueEvent(tx, {
        eventName: "opportunity.economics_updated.v1",
        aggregateType: "intel_candidate",
        aggregateId: row.id,
        idempotencyKey: `opportunity.economics_updated:${row.id}:${version}:${randomUUID()}`,
        payload: { subjectType: "intel_candidate", subjectId: row.id, version, modelVersion: economics.modelVersion, tier: economics.tier, netProfitUsd: economics.netProfitUsd, gates: economics.gates },
      });
      return { candidateId: row.id, version };
    });
}

export async function listEvidence(subjectType: EvidenceSubject, subjectId: string) {
  return getDb()
    .selectFrom("opportunity_evidence")
    .select(["id", "kind", "url", "title", "excerpt", "label", sql<string | null>`observed_at::text`.as("observed_at"), sql<string>`captured_at::text`.as("captured_at"), "content_hash"])
    .where("subject_type", "=", subjectType)
    .where("subject_id", "=", subjectId)
    .orderBy("captured_at")
    .execute();
}

export async function listEconomicsVersions(subjectType: "intel_candidate" | "opportunity", subjectId: string) {
  return getDb()
    .selectFrom("opportunity_economics_versions")
    .select(["version", "model_version", "mode", "outputs", "tier", "gates", sql<string>`created_at::text`.as("created_at")])
    .where("subject_type", "=", subjectType)
    .where("subject_id", "=", subjectId)
    .orderBy("version", "desc")
    .limit(50)
    .execute();
}
