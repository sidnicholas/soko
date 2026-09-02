import { z } from "zod";
import { SignalChannel, SignalKind } from "@opportunity-os/contracts";

/** Multi-channel signal intake (browser extension, feeds, user-submitted). */
export const SignalSubmitSchema = z.object({
  channel: SignalChannel,
  kind: SignalKind,
  source_id: z.string().min(1),
  external_ref: z.string().min(1).optional(),
  title: z.string().optional(),
  description: z.string().min(1),
  category: z.string().optional(),
  price_minor: z.number().int().positive().optional(),
  currency: z.string().min(3).max(12).default("USD"),
  source_reliability: z.number().min(0).max(1).default(0.5),
  raw: z.record(z.unknown()).optional(),
});
export type SignalSubmitBody = z.infer<typeof SignalSubmitSchema>;
