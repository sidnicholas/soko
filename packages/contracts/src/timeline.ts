import { z } from "zod";
import { zIso } from "./ids";

/**
 * Where a timeline entry was read from. Each fact comes from exactly one
 * source so nothing appears twice: the hash-chained audit trail for anything
 * that writes one, the outbox for aggregates that don't (missions, approvals),
 * plus the evidence ledger, immutable mission versions, and discovered
 * opportunities (Phase 4 timelines).
 */
export const TimelineSource = z.enum(["audit", "event", "evidence", "mission_version", "opportunity"]);
export type TimelineSource = z.infer<typeof TimelineSource>;

/** One row of a mission or transaction timeline, merged across sources and ordered by `at`. */
export const TimelineEntry = z.object({
  id: z.string(),
  at: zIso,
  source: TimelineSource,
  /** Dotted action name without the event version suffix, e.g. "settlement.released", "approval.requested". */
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.string(),
  actor: z.string().nullable(),
  summary: z.string().nullable(),
  /** Audit/evidence chain hash, when the source is hash-chained. */
  hash: z.string().nullable(),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;
