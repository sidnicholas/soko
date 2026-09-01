"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge, Card, DataTable, EmptyState, PageHeader, formatDuration, formatMoney, formatScore, tokens } from "@opportunity-os/ui";
import { api } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";
import { riskBand, scoreTone } from "../../lib/opportunity";

export default function OpportunitiesPage() {
  const router = useRouter();
  const opportunities = useAsync(() => api.listOpportunities(), []);

  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <PageHeader
        eyebrow="Opportunities"
        title="Ranked opportunities"
        subtitle="Every candidate scored on transparent economics and component risk. Highest overall score first — act on the ones worth your time."
      />

      <Card flush>
        <AsyncView state={opportunities} loadingLabel="Loading opportunities">
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState
                title="No opportunities yet"
                description="Active missions surface opportunities here as connectors and scoring complete. Create or resume a mission to start the engine."
                action={
                  <Link href="/" className="oos-link">
                    Go to Search / Ask
                  </Link>
                }
              />
            ) : (
              <DataTable
                rows={rows}
                getRowKey={(o) => o.id}
                onRowClick={(o) => router.push(`/opportunities/${o.id}`)}
                columns={[
                  {
                    key: "rank",
                    header: "#",
                    width: 44,
                    render: (_o, i) => <span style={{ color: tokens.color.inkSubtle, fontVariantNumeric: "tabular-nums" }}>{i + 1}</span>,
                  },
                  {
                    key: "opportunity",
                    header: "Opportunity",
                    render: (o) => (
                      <div style={{ display: "flex", flexDirection: "column" }}>
                        <Link href={`/opportunities/${o.id}`} className="oos-link">
                          {o.next_action ?? `Opportunity ${o.id.slice(0, 8)}`}
                        </Link>
                        <span style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs, textTransform: "capitalize" }}>
                          {o.transaction_role}
                        </span>
                      </div>
                    ),
                  },
                  { key: "status", header: "Status", render: (o) => <Badge status={o.status} />, width: 150 },
                  {
                    key: "score",
                    header: "Score",
                    align: "right",
                    render: (o) => <Badge tone={scoreTone(o.overall_score)}>{formatScore(o.overall_score)}</Badge>,
                  },
                  {
                    key: "profit",
                    header: "Net profit",
                    align: "right",
                    render: (o) => <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>{formatMoney(o.expected_net_profit)}</span>,
                  },
                  {
                    key: "capital",
                    header: "Capital",
                    align: "right",
                    render: (o) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatMoney(o.capital_required)}</span>,
                  },
                  {
                    key: "close",
                    header: "Close prob.",
                    align: "right",
                    render: (o) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatScore(o.close_probability)}</span>,
                  },
                  {
                    key: "ttc",
                    header: "Time to cash",
                    align: "right",
                    render: (o) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatDuration(o.time_to_cash_minutes)}</span>,
                  },
                  {
                    key: "risk",
                    header: "Risk",
                    align: "right",
                    render: (o) => {
                      const band = riskBand(Math.max(o.fraud_risk_score, o.compliance_risk_score));
                      return <Badge tone={band.tone}>{band.label}</Badge>;
                    },
                  },
                ]}
              />
            )
          }
        </AsyncView>
      </Card>
    </div>
  );
}
