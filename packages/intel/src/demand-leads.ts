import { createHash } from "node:crypto";
import { insertIntelLead, listUnraisedDemand, markDemandConsidered } from "@opportunity-os/db";
import { DEMAND_SIGNAL_TYPES, parseFieldMap } from "@opportunity-os/connectors-sdk";
import { getApifySource } from "@opportunity-os/db";
import { createLogger } from "@opportunity-os/observability";
import { compsQuery } from "./deals";

/**
 * Actor demand → demand leads (ADR-042 addendum 2). Buyer items from actor
 * sources — Alibaba RFQs, Craigslist "WANTED" posts — become demand leads, so
 * the demand lane searches for suppliers and assesses them, and their items
 * steer the marketplace searches (search plans with fromDemand). Free: no
 * model call here. Expired requests are not raised.
 */

const log = createLogger("intel:demand-leads");

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function supplierQueries(item: string): string[] {
  return [`${item} supplier`, `${item} wholesale manufacturer`];
}

export async function raiseDemandLeads(opts: { limit: number; now?: Date }): Promise<{ considered: number; raised: number; expired: number }> {
  const now = opts.now ?? new Date();
  const pending = await listUnraisedDemand(opts.limit);
  const signals = new Map<string, string>();
  let raised = 0;
  let expired = 0;
  for (const d of pending) {
    if (!signals.has(d.source_id)) {
      const parsed = parseFieldMap((await getApifySource(d.source_id))?.apify_field_map);
      signals.set(d.source_id, "map" in parsed && parsed.map.signal ? parsed.map.signal : "purchase_request");
    }
    const c = (d.content ?? {}) as Record<string, unknown>;
    const title = str(c["title"]);
    const url = typeof (c as { url?: unknown }).url === "string" ? (c as { url: string }).url : null;
    const deadline = str(c["deadline"]);
    const deadlineAt = deadline && !Number.isNaN(Date.parse(deadline)) ? new Date(deadline) : null;
    if (deadlineAt && deadlineAt.getTime() <= now.getTime()) {
      expired++;
      await markDemandConsidered(d.observation_id, null);
      continue;
    }
    const item = title ? compsQuery(title) : null;
    if (!title || !item) {
      await markDemandConsidered(d.observation_id, null);
      continue;
    }
    const quantity = num(c["quantity"]);
    const unit = str(c["quantity_unit"]);
    const location = (c["location"] as { label?: unknown } | null)?.label;
    const where = typeof location === "string" ? location : null;
    const qty = quantity !== null ? `${quantity}${unit ? ` ${unit}` : ""}` : null;
    const link = url ?? `apify:${d.source_id}:${d.external_id}`;
    const soon = deadlineAt ? deadlineAt.getTime() - now.getTime() < 7 * 86_400_000 : false;
    const signal = signals.get(d.source_id)!;
    const leadId = await insertIntelLead({
      runId: null,
      kind: "demand",
      title,
      summary: [`Buyer request on ${d.source_name}`, qty ? `for ${qty}` : null, where ? `from ${where}` : null, deadlineAt ? `; closes ${deadlineAt.toISOString().slice(0, 10)}` : null].filter(Boolean).join(" ") + ".",
      url: link,
      urlHash: createHash("sha256").update(link).digest("hex"),
      hostname: url ? new URL(url).hostname.replace(/^www\./, "") : "apify",
      query: `actor-demand:${d.source_name}`,
      searchProvider: "apify",
      publishedAt: d.first_seen_at,
      ageText: null,
      item,
      category: null,
      quantity: qty,
      location: where,
      deadline: deadlineAt ? deadlineAt.toISOString() : null,
      priceMinor: null,
      currency: null,
      urgency: soon ? "high" : "medium",
      credibility: 0.6,
      contact: { channel: "marketplace_message", value: null, label: "source_fact" },
      facts: [
        { field: "request", value: title.slice(0, 300), label: "source_fact" },
        ...(qty ? [{ field: "quantity", value: qty, label: "source_fact" }] : []),
        ...(where ? [{ field: "buyer_location", value: where, label: "source_fact" }] : []),
        ...(deadlineAt ? [{ field: "deadline", value: deadlineAt.toISOString().slice(0, 10), label: "source_fact" }] : []),
      ],
      oppositeQueries: supplierQueries(item),
      signalType: (DEMAND_SIGNAL_TYPES as readonly string[]).includes(signal) ? signal : "purchase_request",
      evidenceLevel: "observed",
    });
    await markDemandConsidered(d.observation_id, leadId);
    if (leadId) raised++;
  }
  const out = { considered: pending.length, raised, expired };
  if (pending.length) log.info(out, "demand_leads.raised");
  return out;
}
