"use client";

import { useState } from "react";
import { Button, Card, DataTable, EmptyState, PageHeader, StatCard, tokens, type Column } from "@opportunity-os/ui";
import { api, type YieldReport } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";

type Day = YieldReport["intelByDay"][number];
type ProviderRow = YieldReport["intelByProvider"][number];

const PERIODS = [7, 14, 30, 90] as const;
const money = (n: number) => `$${n.toFixed(2)}`;
const num = { fontVariantNumeric: "tabular-nums" } as const;
const words = (s: string) => s.replaceAll("_", " ");

/** Opportunity statuses in pipeline order, so the funnel reads left to right. */
const STATUS_ORDER = ["candidate", "qualified", "awaiting_approval", "approved", "executing", "closed", "rejected", "expired"];

function Totals({ r }: { r: YieldReport }) {
  const spent = r.intelByDay.reduce((s, d) => s + d.searchUsd + d.llmUsd, 0);
  const search = r.intelByDay.reduce((s, d) => s + d.searchUsd, 0);
  const runs = r.intelByDay.reduce((s, d) => s + d.runs, 0);
  const leads = r.intelByDay.reduce((s, d) => s + d.leads, 0);
  const actionable = r.intelByDay.reduce((s, d) => s + d.actionable, 0);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: tokens.space.md }}>
      <StatCard label="Spent" value={money(spent)} hint={`${money(search)} search · ${money(spent - search)} model · ${runs} runs`} />
      <StatCard label="Leads found" value={String(leads)} hint={runs > 0 ? `${(leads / runs).toFixed(1)} per run` : "no runs"} />
      <StatCard label="Actionable" value={String(actionable)} hint="act now + verify next" tone={actionable > 0 ? "success" : undefined} />
      <StatCard
        label="Cost per actionable lead"
        value={actionable > 0 ? money(spent / actionable) : "—"}
        hint="the number to bring down"
        tone="info"
      />
    </div>
  );
}

function SpendBar({ d, max }: { d: Day; max: number }) {
  const width = (usd: number) => `${max > 0 ? (usd / max) * 100 : 0}%`;
  return (
    <div
      title={`${money(d.searchUsd)} search, ${money(d.llmUsd)} model`}
      style={{ display: "flex", height: 8, width: 120, background: tokens.color.surfaceMuted, borderRadius: 4, overflow: "hidden" }}
    >
      <div style={{ width: width(d.searchUsd), background: tokens.color.inkSubtle }} />
      <div style={{ width: width(d.llmUsd), background: tokens.color.accent }} />
    </div>
  );
}

function ByDay({ r }: { r: YieldReport }) {
  const max = Math.max(0, ...r.intelByDay.map((d) => d.searchUsd + d.llmUsd));
  const columns: Column<Day>[] = [
    { key: "day", header: "Day (UTC)", render: (d) => d.day },
    { key: "runs", header: "Runs", align: "right", render: (d) => <span style={num}>{d.runs}</span> },
    { key: "bar", header: "Spend: search | model", render: (d) => <SpendBar d={d} max={max} /> },
    { key: "spent", header: "Spent", align: "right", render: (d) => <span style={num}>{money(d.searchUsd + d.llmUsd)}</span> },
    { key: "leads", header: "Leads", align: "right", render: (d) => <span style={num}>{d.leads}</span> },
    { key: "candidates", header: "Assessed", align: "right", render: (d) => <span style={num}>{d.candidates}</span> },
    { key: "actionable", header: "Actionable", align: "right", render: (d) => <span style={{ ...num, fontWeight: d.actionable > 0 ? 600 : 400 }}>{d.actionable}</span> },
    {
      key: "cpa",
      header: "Cost / actionable",
      align: "right",
      render: (d) => <span style={{ ...num, color: d.costPerActionableUsd === null ? tokens.color.inkSubtle : tokens.color.ink }}>{d.costPerActionableUsd === null ? "—" : money(d.costPerActionableUsd)}</span>,
    },
  ];
  return (
    <Card title="Intel by day" subtitle="Each scheduled run's search and model spend, and what it produced. Newest first." flush>
      <DataTable columns={columns} rows={r.intelByDay} getRowKey={(d) => d.day} empty={<EmptyState compact title="No runs in this period" description="worker-intel runs every 6 hours once it has a search key and a model." />} />
    </Card>
  );
}

function ByProvider({ r }: { r: YieldReport }) {
  const columns: Column<ProviderRow>[] = [
    { key: "provider", header: "Search provider", render: (p) => p.provider },
    { key: "leads", header: "Leads", align: "right", render: (p) => <span style={num}>{p.leads}</span> },
    { key: "actionable", header: "Actionable", align: "right", render: (p) => <span style={num}>{p.actionable}</span> },
    { key: "rate", header: "Actionable rate", align: "right", render: (p) => <span style={num}>{p.leads > 0 ? `${Math.round((p.actionable / p.leads) * 100)}%` : "—"}</span> },
    { key: "contacted", header: "Contacted", align: "right", render: (p) => <span style={num}>{p.contacted}</span> },
    { key: "won", header: "Won", align: "right", render: (p) => <span style={num}>{p.won}</span> },
    { key: "realized", header: "Realized", align: "right", render: (p) => <span style={num}>{money(p.realizedUsd)}</span> },
  ];
  return (
    <Card title="Intel by search provider" subtitle="Compare providers on the same period before keeping a switch (Brave vs Serper)." flush>
      <DataTable columns={columns} rows={r.intelByProvider} getRowKey={(p) => p.provider} empty={<EmptyState compact title="No leads in this period" />} />
    </Card>
  );
}

function Funnel({ r }: { r: YieldReport }) {
  const kinds = [...new Set(r.opportunityFunnel.map((f) => f.kind))].sort();
  const statuses = STATUS_ORDER.filter((s) => r.opportunityFunnel.some((f) => f.status === s)).concat(
    [...new Set(r.opportunityFunnel.map((f) => f.status))].filter((s) => !STATUS_ORDER.includes(s)).sort(),
  );
  const count = (kind: string, status: string) => r.opportunityFunnel.find((f) => f.kind === kind && f.status === status)?.count ?? 0;
  const columns: Column<string>[] = [
    { key: "kind", header: "Kind", render: (k) => words(k) },
    ...statuses.map(
      (s): Column<string> => ({
        key: s,
        header: words(s),
        align: "right",
        render: (k) => {
          const n = count(k, s);
          return <span style={{ ...num, color: n === 0 ? tokens.color.inkSubtle : tokens.color.ink }}>{n}</span>;
        },
      }),
    ),
  ];
  return (
    <Card title="Opportunity pipeline" subtitle="All opportunities by kind and status, all time. Graph arbitrage stays expired while embeddings are the echo stub." flush>
      <DataTable columns={columns} rows={kinds} getRowKey={(k) => k} empty={<EmptyState compact title="No opportunities yet" />} />
    </Card>
  );
}

export default function YieldPage() {
  const [days, setDays] = useState<number>(30);
  const report = useAsync(() => api.yieldReport(days), [days]);
  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <PageHeader
        eyebrow="Opportunity intelligence"
        title="Yield & Spend"
        subtitle="What the intel sweep costs and what it finds. Use this as the baseline before changing search provider, model or query volume."
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
      <AsyncView state={report} loadingLabel="Loading yield and spend">
        {(r) => (
          <>
            <Totals r={r} />
            <ByDay r={r} />
            <ByProvider r={r} />
            <Funnel r={r} />
          </>
        )}
      </AsyncView>
    </div>
  );
}
