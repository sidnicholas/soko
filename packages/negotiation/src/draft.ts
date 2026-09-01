import { z } from "zod";
import type { CostTelemetry } from "@opportunity-os/contracts";
import { LlmGateway } from "@opportunity-os/llm-gateway";
import { createLogger } from "@opportunity-os/observability";

const log = createLogger("negotiation:draft");

export interface NegotiationContext {
  side: "buy" | "sell";
  itemTitle: string;
  itemDescription: string;
  /** What we aim to pay (buy) or charge (sell), minor units. */
  targetPriceMinor: number | null;
  /** Authorized ceiling for this negotiation, minor units. */
  maxAmountMinor: number | null;
  currency: string;
  counterpartyName?: string | null;
}

export interface DraftMessage {
  intent: string;
  subject?: string;
  body: string;
}

export interface ApprovedBounds {
  targetPriceMinor: number | null;
  maxAmountMinor: number | null;
  currency: string;
}

export interface NegotiationDraftResult {
  messages: DraftMessage[];
  approvedBounds: ApprovedBounds;
  source: "llm" | "template";
  telemetry?: CostTelemetry;
}

const DraftSchema = z.object({
  messages: z
    .array(z.object({ intent: z.string(), subject: z.string().optional(), body: z.string().min(1) }))
    .min(1),
});

function money(minor: number | null, currency: string): string {
  return minor === null ? "an agreed price" : `${currency} ${(minor / 100).toFixed(2)}`;
}

/**
 * Deterministic, professional, explicitly non-binding draft. Serves as the
 * reliable backbone and the fallback when the LLM path is unavailable. Only
 * ever a DRAFT for a human to review and send (§13.5) — never sent here.
 */
export function templateDraft(ctx: NegotiationContext): DraftMessage[] {
  const who = ctx.counterpartyName?.trim() ? ctx.counterpartyName.trim() : "there";
  const detail = ctx.itemDescription ? ` For reference: ${ctx.itemDescription}` : "";
  if (ctx.side === "buy") {
    return [
      {
        intent: "opening_inquiry",
        subject: `Inquiry: ${ctx.itemTitle}`,
        body: `Hi ${who},\n\nI'm interested in ${ctx.itemTitle}. Is it still available, and can you confirm condition and lead time?${detail}\n\nThanks!`,
      },
      {
        intent: "price_proposal",
        subject: `Offer for ${ctx.itemTitle}`,
        body: `Thanks for confirming. I'd like to move quickly at ${money(ctx.targetPriceMinor, ctx.currency)}${
          ctx.maxAmountMinor !== null ? `, with room toward ${money(ctx.maxAmountMinor, ctx.currency)} for the right terms` : ""
        }. Would that work? I can arrange payment and logistics promptly.`,
      },
    ];
  }
  return [
    {
      intent: "opening_offer",
      subject: `Available: ${ctx.itemTitle}`,
      body: `Hi ${who},\n\nI can supply ${ctx.itemTitle} at ${money(ctx.targetPriceMinor, ctx.currency)}.${detail}\n\nLet me know if you'd like to proceed.`,
    },
  ];
}

const SYSTEM = [
  "You draft a professional, concise, NON-BINDING outreach message for a human to review and send.",
  "Never commit to a purchase or sale, never claim to send anything, never invent facts.",
  'Output ONLY minified JSON: {"messages":[{"intent":string,"subject":string,"body":string}]}.',
].join("\n");

/**
 * §11.2(4)/§13.5 prepare (never send) negotiation drafts. Attempts LLM drafting
 * (task class `negotiation_drafting`) and falls back to the deterministic
 * template when the model is unavailable or returns an unusable payload.
 */
export async function draftNegotiation(
  ctx: NegotiationContext,
  gateway: LlmGateway = LlmGateway.default(),
): Promise<NegotiationDraftResult> {
  const approvedBounds: ApprovedBounds = {
    targetPriceMinor: ctx.targetPriceMinor,
    maxAmountMinor: ctx.maxAmountMinor,
    currency: ctx.currency,
  };

  let messages: DraftMessage[] | undefined;
  let source: NegotiationDraftResult["source"] = "template";
  let telemetry: CostTelemetry | undefined;

  try {
    const prompt = `Draft ${ctx.side}-side outreach for "${ctx.itemTitle}". Target ${money(ctx.targetPriceMinor, ctx.currency)}, ceiling ${money(ctx.maxAmountMinor, ctx.currency)}.`;
    const out = await gateway.runStructured(
      { taskClass: "negotiation_drafting", system: SYSTEM, prompt, untrustedContext: `${ctx.itemTitle}\n${ctx.itemDescription}` },
      DraftSchema,
    );
    messages = out.value.messages;
    source = "llm";
    telemetry = out.telemetry;
  } catch (err) {
    log.debug({ err: String(err) }, "negotiation.draft.llm_fallback");
  }

  return { messages: messages ?? templateDraft(ctx), approvedBounds, source, telemetry };
}
