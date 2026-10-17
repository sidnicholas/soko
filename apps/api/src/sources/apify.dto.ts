import { z } from "zod";

/** Request bodies for Apify sources and the ingestion quarantine (ADR-042). */
const actorId = z
  .string()
  .trim()
  .regex(/^([\w.-]+[~/][\w.-]+|[A-Za-z0-9]{17})$/, "username~actor-name, or the actor's id");
const build = z
  .string()
  .trim()
  .regex(/^[\w.-]{1,40}$/, "a build number such as 0.1.23, or a fixed tag");
const fieldNames = z.array(z.string().trim().min(1).max(100)).max(300);

export const ApifySourceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** The site the actor reads, e.g. govdeals.com. */
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "a domain such as example.com"),
  orientation: z.enum(["demand", "supply"]),
  actorId,
  actorVersion: build,
  input: z.record(z.unknown()).default({}),
  fieldMap: z.record(z.unknown()),
  expectedFields: fieldNames.nullish(),
  maxItems: z.number().int().positive().max(1000).nullish(),
  maxChargeUsd: z.number().positive().max(100).nullish(),
  minIntervalMinutes: z.number().int().positive().max(43_200).nullish(),
  maxDailyUsd: z.number().positive().max(100).nullish(),
  /** Build search URLs each run from demand and a keyword × city list (validated by the service). */
  searchPlan: z.record(z.unknown()).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  evidenceUrl: z.string().url().max(2000).nullish(),
});
export type ApifySourceBody = z.infer<typeof ApifySourceSchema>;

export const ApifyConfigSchema = z.object({
  actorId: actorId.optional(),
  actorVersion: build.optional(),
  input: z.record(z.unknown()).optional(),
  fieldMap: z.record(z.unknown()).optional(),
  expectedFields: fieldNames.nullable().optional(),
  maxItems: z.number().int().positive().max(1000).nullable().optional(),
  maxChargeUsd: z.number().positive().max(100).nullable().optional(),
  searchPlan: z.record(z.unknown()).nullable().optional(),
  minIntervalMinutes: z.number().int().positive().max(43_200).nullable().optional(),
  maxDailyUsd: z.number().positive().max(100).nullable().optional(),
});
export type ApifyConfigBody = z.infer<typeof ApifyConfigSchema>;

export const QuarantineDecisionSchema = z
  .object({
    decision: z.enum(["release", "discard", "map_category"]),
    /** On release of an item held for unexpected fields: expect those fields from now on. */
    acceptFields: z.boolean().optional(),
    /** For map_category: the category the held source value means. */
    category: z.string().trim().max(40).optional(),
  })
  .refine((b) => b.decision !== "map_category" || !!b.category, { message: "category is required to map a category", path: ["category"] });
export type QuarantineDecisionBody = z.infer<typeof QuarantineDecisionSchema>;
