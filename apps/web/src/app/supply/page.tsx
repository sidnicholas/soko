"use client";

import { useState } from "react";
import { Button, PageHeader, StatCard, tokens } from "@opportunity-os/ui";
import { api } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";
import { IntelligenceLeads } from "../../components/IntelligenceLeads";

const PERIODS = [7, 30, 90] as const;

/** PRD v2 FR-02: surplus, liquidation, overstock and spare capacity, with stated terms and the buyer search. */
export default function SupplyPage() {
  const [days, setDays] = useState<number>(30);
  const data = useAsync(() => api.supplyIntelligence(days), [days]);
  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <PageHeader
        eyebrow="Supply intelligence"
        title="Surplus Supply"
        subtitle="Sellers with unusual availability: surplus, liquidation, closeouts, used equipment, spare capacity. Verified listings are kept apart from inferred surplus; liquidation stock never assumes clear title."
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
      <AsyncView state={data} loadingLabel="Loading supply signals">
        {({ leads }) => (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: tokens.space.md }}>
              <StatCard label="Supply signals" value={String(leads.length)} hint={`last ${days} days`} />
              <StatCard label="Verified listings" value={String(leads.filter((l) => l.evidence_level === "observed").length)} hint={`${leads.filter((l) => l.evidence_level === "inferred").length} inferred`} tone="success" />
              <StatCard label="Buyers found" value={String(leads.filter((l) => l.counterpart_status === "found").length)} hint={`${leads.filter((l) => l.counterpart_status === "pending").length} searches queued`} tone="info" />
              <StatCard label="Title unverified" value={String(leads.filter((l) => l.title_unverified).length)} hint="liquidation or distressed" tone="warning" />
            </div>
            <IntelligenceLeads leads={leads} side="supply" />
          </>
        )}
      </AsyncView>
    </div>
  );
}
