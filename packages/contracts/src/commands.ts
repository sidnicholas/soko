import { z } from "zod";
import { zId, zIso } from "./ids";
import { ActorType } from "./enums";

/**
 * Typed command envelope for the modular-monolith command bus. Domains
 * communicate through commands/events so they can later be extracted into
 * independent microservices without rewriting business logic (§4).
 */
export const CommandEnvelope = z.object({
  id: zId,
  name: z.string(),
  issued_at: zIso,
  issuer: z.object({
    type: ActorType,
    id: z.string().nullable(),
  }),
  target_entity_type: z.string().nullable(),
  target_entity_id: z.string().nullable(),
  idempotency_key: z.string(),
  payload: z.record(z.unknown()),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;
