"use client";

import Link from "next/link";
import type { TimelineEntry } from "@opportunity-os/contracts";
import {
  Badge,
  Card,
  PageHeader,
  StatCard,
  formatDateTime,
  formatMoney,
  statusLabel,
  tokens,
} from "@opportunity-os/ui";
import { api, type TransactionDetail } from "../../../lib/api";
import { useAsync } from "../../../lib/useAsync";
import { AsyncView } from "../../../components/AsyncView";
import { EntityTimeline } from "../../../components/EntityTimeline";

export default function TransactionDetailPage({ params }: { params: { id: string } }) {
  const tx = useAsync<TransactionDetail>(() => api.getTransaction(params.id), [params.id]);
  const timeline = useAsync<TimelineEntry[]>(() => api.getTransactionTimeline(params.id), [params.id]);

  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <AsyncView state={tx} loadingLabel="Loading transaction">
        {(t) => (
          <>
            <PageHeader
              eyebrow="Transaction"
              title={`Transaction ${t.id.slice(0, 8)}`}
              subtitle={
                <>
                  From opportunity{" "}
                  <Link href={`/opportunities/${t.opportunity_id}`} className="oos-link">
                    {t.opportunity_id.slice(0, 8)}
                  </Link>
                </>
              }
              actions={<Badge status={t.status} />}
            />

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: tokens.space.md }}>
              <StatCard label="Gross amount" value={formatMoney(t.gross_amount)} tone="info" />
              <StatCard label="Platform revenue" value={formatMoney(t.platform_revenue)} tone="success" />
              <StatCard label="Terms version" value={`v${t.terms_version}`} hint={`${t.terms_hash.slice(0, 12)}…`} />
              <StatCard label="Settlement" value={t.settlement_plan ? statusLabel(t.settlement_plan.status) : "None"} tone={t.settlement_plan ? "progress" : "neutral"} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: tokens.space.lg, alignItems: "start" }}>
              <Card title="Parties & terms">
                <dl style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: tokens.space.md, margin: 0 }}>
                  {[
                    ["Buyer", t.buyer_id ?? "—"],
                    ["Seller", t.seller_id ?? "—"],
                    ["Currency", t.currency],
                    ["Created", formatDateTime(t.created_at)],
                    ["Terms hash", `${t.terms_hash.slice(0, 20)}…`],
                    ["Settlement plan", t.settlement_plan_id ?? "Not created"],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <dt style={{ fontSize: tokens.fontSize.xs, textTransform: "uppercase", letterSpacing: "0.04em", color: tokens.color.inkSubtle }}>{k}</dt>
                      <dd style={{ margin: `${tokens.space.xs}px 0 0`, fontSize: tokens.fontSize.sm, color: tokens.color.ink, wordBreak: "break-word", fontFamily: k === "Terms hash" ? tokens.font.mono : undefined }}>
                        {v}
                      </dd>
                    </div>
                  ))}
                </dl>
                {t.settlement_plan && (
                  <div style={{ marginTop: tokens.space.md }}>
                    <Link href="/payments" className="oos-link">
                      View settlement & milestones →
                    </Link>
                  </div>
                )}
              </Card>

              <Card title="Timeline" subtitle="Settlement, payouts, evidence, approvals and negotiation — newest first (§21).">
                <AsyncView state={timeline} loadingLabel="Loading timeline">
                  {(entries) => (
                    <EntityTimeline
                      entries={entries}
                      emptyDescription="Lifecycle events for this transaction will appear here as it progresses."
                    />
                  )}
                </AsyncView>
              </Card>
            </div>
          </>
        )}
      </AsyncView>
    </div>
  );
}
