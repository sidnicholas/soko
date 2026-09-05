import { z } from "zod";

/** §11 messaging backlog — which channel + identity to dispatch this exact approved text to. */
export const SendNegotiationSchema = z.object({
  channel: z.enum(["telegram", "sms", "email", "whatsapp"]),
  identity: z.string().min(1),
  text: z.string().min(1),
});
export type SendNegotiationBody = z.infer<typeof SendNegotiationSchema>;
