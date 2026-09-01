import { z } from "zod";
import { Money } from "./money";
import { GeoLocation } from "./geo";
import { Urgency, PaymentMethodFamily } from "./enums";

/** A structured, machine-checkable constraint extracted from natural language. */
export const Constraint = z.object({
  field: z.string(),
  operator: z.enum(["eq", "neq", "gte", "lte", "contains", "in", "range"]).default("eq"),
  value: z.unknown(),
  hard: z.boolean().default(true),
});
export type Constraint = z.infer<typeof Constraint>;

export const Recurrence = z.object({
  interval: z.enum(["daily", "weekly", "monthly"]),
  count: z.number().int().positive().optional(),
});
export type Recurrence = z.infer<typeof Recurrence>;

/**
 * §7 Demand Specification Contract — the normalized output of the demand
 * parser and the immutable payload stored on each MissionVersion.
 */
export const DemandSpecification = z.object({
  what: z.object({
    description: z.string(),
    urls: z.array(z.string().url()).optional(),
    imageRefs: z.array(z.string()).optional(),
    identifiers: z.record(z.string()).optional(),
  }),
  budget: z.object({
    target: Money.optional(),
    maximum: Money.optional(),
    flexible: z.boolean(),
    includesFees: z.boolean().optional(),
    includesDelivery: z.boolean().optional(),
  }),
  quality: z.object({
    naturalLanguage: z.string().optional(),
    constraints: z.array(Constraint),
  }),
  timing: z.object({
    neededBy: z.string().optional(),
    urgency: Urgency,
    recurring: Recurrence.optional(),
  }),
  importance: z
    .object({
      context: z.string().optional(),
    })
    .optional(),
  payment: z.object({
    acceptableMethods: z.array(PaymentMethodFamily),
  }),
  fulfillment: z.object({
    type: z.enum(["ship", "pickup", "onsite", "digital", "other"]),
    location: GeoLocation.optional(),
    radiusMiles: z.number().optional(),
  }),
  flexibility: z.object({
    substitutesAllowed: z.boolean(),
    negotiableFields: z.array(z.string()),
    nonNegotiables: z.array(Constraint),
  }),
  negotiationAuthorization: z.object({
    mayPrepare: z.boolean(),
    maySend: z.boolean().default(false),
    maxAmount: Money.optional(),
  }),
});
export type DemandSpecification = z.infer<typeof DemandSpecification>;
