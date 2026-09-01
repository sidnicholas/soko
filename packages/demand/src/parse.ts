import { DemandSpecification, type CostTelemetry } from "@opportunity-os/contracts";
import { LlmGateway } from "@opportunity-os/llm-gateway";
import { createLogger } from "@opportunity-os/observability";
import { heuristicDemandSpec, type DemandHints, type DemandParseInput } from "./heuristic";

const log = createLogger("demand:parse");

export interface DemandParseResult {
  spec: DemandSpecification;
  source: "llm" | "heuristic";
  telemetry?: CostTelemetry;
}

const SYSTEM = [
  "You convert a buyer's natural-language request into a Demand Specification.",
  "Output ONLY minified JSON — no prose, no code fences — matching this shape:",
  '{"what":{"description":string},"budget":{"flexible":boolean,"target"?:{"amount":cents_int,"currency":string},"maximum"?:{"amount":cents_int,"currency":string}},"quality":{"constraints":[{"field":string,"operator":"eq","value":any,"hard":boolean}]},"timing":{"urgency":"immediate|today|days|scheduled|flexible","neededBy"?:string},"payment":{"acceptableMethods":["card"]},"fulfillment":{"type":"ship|pickup|onsite|digital|other"},"flexibility":{"substitutesAllowed":boolean,"negotiableFields":string[],"nonNegotiables":[]},"negotiationAuthorization":{"mayPrepare":boolean,"maySend":boolean}}',
  "Money is integer minor units (cents). Never invent facts absent from the request.",
].join("\n");

/**
 * §3.1(3)/§7 demand parser. Attempts LLM extraction (task class `extraction`,
 * validated against the DemandSpecification schema) and falls back to the
 * deterministic heuristic whenever the model is unavailable or returns an
 * unusable payload. Structured hints (explicit budget/urgency/needed-by from a
 * form) always win over inferred values.
 */
export async function parseDemand(
  input: DemandParseInput,
  gateway: LlmGateway = LlmGateway.default(),
): Promise<DemandParseResult> {
  let base: DemandSpecification | undefined;
  let source: DemandParseResult["source"] = "heuristic";
  let telemetry: CostTelemetry | undefined;

  try {
    const out = await gateway.runStructured(
      {
        taskClass: "extraction",
        system: SYSTEM,
        prompt: "Extract the demand specification from the request below.",
        untrustedContext: input.text,
      },
      DemandSpecification,
    );
    base = out.value;
    source = "llm";
    telemetry = out.telemetry;
  } catch (err) {
    log.debug({ err: String(err) }, "demand.parse.llm_fallback");
  }

  const spec = applyHints(base ?? heuristicDemandSpec(input), input.hints);
  return { spec, source, telemetry };
}

/** Overlay explicit form hints onto a parsed spec, then re-validate. */
function applyHints(spec: DemandSpecification, hints?: DemandHints): DemandSpecification {
  if (!hints) return spec;
  const currency = hints.currency ?? spec.budget.maximum?.currency ?? spec.budget.target?.currency ?? "USD";
  return DemandSpecification.parse({
    ...spec,
    budget: {
      ...spec.budget,
      ...(hints.budgetMaxMinor !== undefined
        ? { maximum: { amount: hints.budgetMaxMinor, currency }, flexible: false }
        : {}),
    },
    timing: {
      ...spec.timing,
      ...(hints.urgency ? { urgency: hints.urgency } : {}),
      ...(hints.neededBy ? { neededBy: hints.neededBy } : {}),
    },
  });
}
