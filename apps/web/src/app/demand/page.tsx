"use client";

import { useState } from "react";
import { Badge, Button, Card, DataTable, EmptyState, PageHeader, StatCard, tokens, type Column, type Tone } from "@opportunity-os/ui";
import { api, ApiError, type DemandHypothesis } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";
import { IntelligenceLeads } from "../../components/IntelligenceLeads";

const PERIODS = [7, 30, 90] as const;
const words = (s: string | null | undefined) => (s ?? "").replaceAll("_", " ");
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
const STATUS_TONE: Record<DemandHypothesis["status"], Tone> = { watching: "info", confirmed: "success", expired: "neutral", dismissed: "neutral" };

/** Inferred demand: a possible buyer to keep checking, never one to contact as if confirmed. */
function Watchlist({ hypotheses, onChange }: { hypotheses: DemandHypothesis[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(h: DemandHypothesis) {
    setBusy(h.id);
    setError(null);
    try {
      await api.setHypothesisStatus(h.id, h.status === "watching" ? "dismissed" : "watching");
      onChange();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Change failed.");
    } finally {
      setBusy(null);
    }
  }

  const columns: Column<DemandHypothesis>[] = [
    {
      key: "hypothesis",
      header: "Hypothesis",
      render: (h) => (
        <div style={{ maxWidth: "44ch" }}>
          <div style={{ fontWeight: tokens.weight.medium }}>{h.hypothesis}</div>
          <div style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkMuted }}>
            Observed:{" "}
            <a href={h.source_url} target="_blank" rel="noopener noreferrer nofollow" className="oos-link">
              {h.basis}
            </a>
          </div>
        </div>
      ),
    },
    { key: "signal", header: "Signal", render: (h) => <span style={{ fontSize: tokens.fontSize.xs }}>{words(h.signal_type)}</span> },
    { key: "confidence", header: "Confidence", align: "right", render: (h) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{Math.round(h.confidence * 100)}%</span> },
    {
      key: "status",
      header: "Status",
      render: (h) => (
        <div>
          <Badge tone={STATUS_TONE[h.status]}>{h.status}</Badge>
          {h.status_reason && <div style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>{words(h.status_reason)}</div>}
        </div>
      ),
    },
    {
      key: "schedule",
      header: "Next check / expires",
      render: (h) => (
        <span style={{ fontSize: tokens.fontSize.xs }}>
          {h.status === "watching" ? `${day(h.revisit_at)} / ${day(h.expires_at)}` : "—"}
          {h.revisit_count > 0 ? ` · checked ${h.revisit_count}×` : ""}
        </span>
      ),
    },
    {
      key: "action",
      header: "",
      align: "right",
      render: (h) =>
        h.status === "watching" || h.status === "dismissed" ? (
          <Button size="sm" variant="ghost" disabled={busy === h.id} onClick={() => void toggle(h)}>
            {h.status === "watching" ? "Dismiss" : "Watch again"}
          </Button>
        ) : null,
    },
  ];
  return (
    <Card flush title="Watchlist" subtitle="Demand that is only implied (hiring, a new site, a procurement cycle). Revisited on schedule; confirmed only when the party states the need; expires otherwise.">
      {error && <div style={{ padding: tokens.space.md, color: "#b02525", fontSize: tokens.fontSize.sm }}>{error}</div>}
      <DataTable columns={columns} rows={hypotheses} getRowKey={(h) => h.id} empty={<EmptyState compact title="No hypotheses yet" description="The demand lane adds implied demand here as it finds it." />} />
    </Card>
  );
}

/** PRD v2 FR-03: stated demand with the supplier search, and the watchlist of inferred demand. */
export default function DemandPage() {
  const [days, setDays] = useState<number>(30);
  const data = useAsync(() => api.demandIntelligence(days), [days]);
  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <PageHeader
        eyebrow="Demand intelligence"
        title="Emerging Demand"
        subtitle="Buyers who stated a need (RFQs, purchase requests, wanted posts) with the targeted supplier search, and a watchlist of demand that is only implied."
        actions={
          <div style={{ display: "flex", gap: tokens.space.xs }} role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <Button key={p} size="sm" variant={p === days ? "primary" : "secondary"} aria-pressed={p === days} onClick={() => setDays(p)}>
                {p} days
              </Button>
            ))}
          </div>
        }
      />
      <AsyncView state={data} loadingLabel="Loading demand signals">
        {({ leads, hypotheses }) => (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: tokens.space.md }}>
              <StatCard label="Stated demand" value={String(leads.length)} hint={`last ${days} days`} />
              <StatCard label="Suppliers found" value={String(leads.filter((l) => l.counterpart_status === "found").length)} hint={`${leads.filter((l) => l.counterpart_status === "pending").length} searches queued`} tone="info" />
              <StatCard label="On the watchlist" value={String(hypotheses.filter((h) => h.status === "watching").length)} hint={`${hypotheses.filter((h) => h.status === "confirmed").length} confirmed`} />
            </div>
            <IntelligenceLeads leads={leads} side="demand" />
            <Watchlist hypotheses={hypotheses} onChange={data.reload} />
          </>
        )}
      </AsyncView>
    </div>
  );
}
