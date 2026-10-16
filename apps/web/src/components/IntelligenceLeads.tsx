"use client";

import { useState } from "react";
import { Badge, Card, DataTable, EmptyState, tokens, tonePalette, type Column, type Tone } from "@opportunity-os/ui";
import type { IntelligenceLead } from "../lib/api";

const words = (s: string | null | undefined) => (s ?? "").replaceAll("_", " ");
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

const BUCKET_TONE: Record<string, Tone> = { act_now: "success", verify_next: "info", watch: "warning", rejected: "danger" };
const COUNTERPART_LABEL: Record<IntelligenceLead["counterpart_status"], string> = {
  pending: "search queued",
  found: "found",
  none_found: "none found",
  not_needed: "not needed",
};

/** Supply terms as stated by the source, one line; empty when none were stated. */
function terms(t: IntelligenceLead["supply_terms"]): string {
  return [
    t.moq && `MOQ ${t.moq}`,
    t.price_breaks && `price ${t.price_breaks}`,
    t.condition && t.condition,
    t.shipping_terms && t.shipping_terms,
    t.expiry && `expires ${t.expiry}`,
    t.capacity && `capacity ${t.capacity}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Leads of one side (PRD v2 FR-02/FR-03): what was observed versus inferred,
 * when it was last seen, and what the search for the other side found.
 */
export function IntelligenceLeads({ leads, side }: { leads: IntelligenceLead[]; side: "supply" | "demand" }) {
  const [open, setOpen] = useState<string | null>(null);
  const columns: Column<IntelligenceLead>[] = [
    {
      key: "lead",
      header: side === "supply" ? "Offer" : "Need",
      render: (l) => (
        <div style={{ maxWidth: "44ch" }}>
          <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="oos-link" style={{ fontWeight: tokens.weight.medium }}>
            {l.title}
          </a>
          <div style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}>
            {l.hostname}
            {l.location ? ` · ${l.location}` : ""}
            {l.quantity ? ` · ${l.quantity}` : ""}
            {l.kind === "problem" ? " · business problem" : ""}
          </div>
          {side === "supply" && terms(l.supply_terms) && <div style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkMuted, marginTop: 2 }}>{terms(l.supply_terms)}</div>}
        </div>
      ),
    },
    { key: "signal", header: "Signal", render: (l) => <span style={{ fontSize: tokens.fontSize.xs }}>{words(l.signal_type) || "—"}</span> },
    {
      key: "evidence",
      header: "Evidence",
      render: (l) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" }}>
          <Badge tone={l.evidence_level === "observed" ? "success" : "warning"}>{l.evidence_level}</Badge>
          {l.title_unverified && <Badge tone="danger">title unverified</Badge>}
        </div>
      ),
    },
    { key: "seen", header: "Last seen", render: (l) => <span style={{ fontSize: tokens.fontSize.xs }}>{day(l.last_seen_at)}{l.seen_count > 1 ? ` (${l.seen_count}×)` : ""}</span> },
    {
      key: "counterpart",
      header: side === "supply" ? "Buyers" : "Suppliers",
      render: (l) => (
        <button
          type="button"
          onClick={() => setOpen(open === l.id ? null : l.id)}
          disabled={l.counterparts.length === 0}
          style={{ background: "none", border: "none", padding: 0, cursor: l.counterparts.length ? "pointer" : "default", color: l.counterparts.length ? tokens.color.accent : tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}
        >
          {COUNTERPART_LABEL[l.counterpart_status]}
          {l.counterparts.length ? ` (${l.counterparts.length})` : ""}
        </button>
      ),
    },
    {
      key: "bucket",
      header: "Queue",
      render: (l) =>
        l.bucket ? (
          <div>
            <Badge tone={BUCKET_TONE[l.bucket] ?? "neutral"}>{words(l.bucket)}</Badge>
            {l.reject_reason && <div style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>{words(l.reject_reason)}</div>}
          </div>
        ) : (
          <span style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>{l.status === "skipped" ? "stale" : "not assessed"}</span>
        ),
    },
  ];
  const selected = open ? leads.find((l) => l.id === open) : undefined;
  return (
    <>
      <Card flush title={`${leads.length} ${side === "supply" ? "supply signals" : "demand signals"}`} subtitle="Observed = stated by the party itself. Inferred = deduced, capped at WATCH, never contacted without confirming first.">
        <DataTable columns={columns} rows={leads} getRowKey={(l) => l.id} empty={<EmptyState compact title="Nothing in this period" description="Signals appear after the lane's next scheduled run." />} />
      </Card>
      {selected && (
        <Card title={side === "supply" ? "Possible buyers" : "Possible suppliers"} subtitle={`Found by the targeted search for: ${selected.title}. Search results, not confirmed parties.`}>
          {selected.counterparts.map((c) => (
            <div key={c.url} style={{ padding: `${tokens.space.xs}px 0`, borderBottom: `1px solid ${tokens.color.border}`, fontSize: tokens.fontSize.sm }}>
              <a href={c.url} target="_blank" rel="noopener noreferrer nofollow" className="oos-link">
                {c.title}
              </a>
              <span style={{ color: tokens.color.inkSubtle }}> · {c.hostname}</span>
              <div style={{ color: tonePalette.neutral.fg, fontSize: tokens.fontSize.xs }}>{c.snippet}</div>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
