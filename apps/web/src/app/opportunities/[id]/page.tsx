"use client";

import { useState } from "react";
import Link from "next/link";
import type { Opportunity } from "@opportunity-os/contracts";
import {
  Badge,
  Button,
  Card,
  PageHeader,
  StatCard,
  formatDuration,
  formatMoney,
  formatScore,
  statusLabel,
  tokens,
  tonePalette,
  type Tone,
} from "@opportunity-os/ui";
import { api } from "../../../lib/api";
import { useAsync } from "../../../lib/useAsync";
import { AsyncView } from "../../../components/AsyncView";
import { riskBand, scoreTone } from "../../../lib/opportunity";

function ScoreMeter({ label, value, tone }: { label: string; value: number; tone: Tone }) {
  const palette = tonePalette[tone];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: tokens.space.xs }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: tokens.fontSize.sm }}>
        <span style={{ color: tokens.color.inkMuted }}>{label}</span>
        <span style={{ fontWeight: 600, color: tokens.color.ink, fontVariantNumeric: "tabular-nums" }}>{formatScore(value)}</span>
      </div>
      <div style={{ height: 8, borderRadius: tokens.radius.pill, background: tokens.color.surfaceMuted, overflow: "hidden" }}>
        <div style={{ width: `${Math.round(Math.min(Math.max(value, 0), 1) * 100)}%`, height: "100%", background: palette.dot }} />
      </div>
    </div>
  );
}

export default function OpportunityDetailPage({ params }: { params: { id: string } }) {
  const state = useAsync<Opportunity>(() => api.getOpportunity(params.id), [params.id]);
  const [busy, setBusy] = useState<null | "reverify" | "negotiate">(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function reverify() {
    setBusy("reverify");
    setNotice(null);
    try {
      await api.reverifyOpportunity(params.id);
      state.reload();
      setNotice("Reverification requested — economics and availability refreshed.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Reverify failed.");
    } finally {
      setBusy(null);
    }
  }

  async function prepareNegotiation() {
    setBusy("negotiate");
    setNotice(null);
    try {
      await api.prepareNegotiation(params.id);
      setNotice("Negotiation draft prepared for your review. Nothing is sent — outbound remains human-gated.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not prepare negotiation.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <AsyncView state={state} loadingLabel="Loading opportunity">
        {(o) => (
          <>
            <PageHeader
              eyebrow={<Link href="/opportunities" className="oos-link">Opportunities</Link>}
              title={o.next_action ?? `Opportunity ${o.id.slice(0, 8)}`}
              subtitle={`Role: ${o.transaction_role} · Score version ${o.score_version}`}
              actions={
                <>
                  <Button variant="secondary" loading={busy === "reverify"} onClick={reverify}>
                    Reverify
                  </Button>
                  <Button variant="primary" loading={busy === "negotiate"} onClick={prepareNegotiation}>
                    Prepare negotiation
                  </Button>
                </>
              }
            />

            <div style={{ display: "flex", gap: tokens.space.md, alignItems: "center", flexWrap: "wrap" }}>
              <Badge status={o.status} />
              <Badge tone={scoreTone(o.overall_score)}>Overall {formatScore(o.overall_score)}</Badge>
              {(() => {
                const band = riskBand(Math.max(o.fraud_risk_score, o.compliance_risk_score));
                return <Badge tone={band.tone}>{band.label} risk</Badge>;
              })()}
            </div>

            {notice && (
              <div style={{ padding: tokens.space.md, borderRadius: tokens.radius.md, background: tokens.color.accentSoft, color: tokens.color.accent, fontSize: tokens.fontSize.sm }}>
                {notice}
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: tokens.space.md }}>
              <StatCard label="Expected revenue" value={formatMoney(o.expected_revenue)} tone="info" />
              <StatCard label="Direct cost" value={formatMoney(o.expected_direct_cost)} />
              <StatCard label="Net profit" value={formatMoney(o.expected_net_profit)} tone="success" hint={`Capital required ${formatMoney(o.capital_required)}`} />
              <StatCard label="Time to cash" value={formatDuration(o.time_to_cash_minutes)} hint={`Close probability ${formatScore(o.close_probability)}`} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: tokens.space.lg }}>
              <Card title="Value & likelihood" subtitle="Higher is better.">
                <div className="oos-stack" style={{ gap: tokens.space.md }}>
                  <ScoreMeter label="Overall score" value={o.overall_score} tone={scoreTone(o.overall_score)} />
                  <ScoreMeter label="Close probability" value={o.close_probability} tone={scoreTone(o.close_probability)} />
                  <ScoreMeter label="Payment certainty" value={o.payment_certainty_score} tone={scoreTone(o.payment_certainty_score)} />
                  <ScoreMeter label="Repeatability" value={o.repeatability_score} tone={scoreTone(o.repeatability_score)} />
                  <ScoreMeter label="Customer value" value={o.customer_value_score} tone={scoreTone(o.customer_value_score)} />
                </div>
              </Card>

              <Card title="Component risk" subtitle="Higher is worse — each factor scored independently (§12).">
                <div className="oos-stack" style={{ gap: tokens.space.md }}>
                  <ScoreMeter label="Fraud risk" value={o.fraud_risk_score} tone={riskBand(o.fraud_risk_score).tone} />
                  <ScoreMeter label="Compliance risk" value={o.compliance_risk_score} tone={riskBand(o.compliance_risk_score).tone} />
                  <ScoreMeter label="Operational friction" value={o.operational_friction_score} tone={riskBand(o.operational_friction_score).tone} />
                </div>
              </Card>
            </div>

            <Card title="Provenance">
              <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: tokens.space.md, margin: 0 }}>
                {[
                  ["Status", statusLabel(o.status)],
                  ["Match ID", o.match_id],
                  ["Score version", o.score_version],
                  ["Last verified", o.last_verified_at ?? "Not yet verified"],
                  ["Expires", o.expires_at ?? "No expiry set"],
                  ["Created", o.created_at],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt style={{ fontSize: tokens.fontSize.xs, textTransform: "uppercase", letterSpacing: "0.04em", color: tokens.color.inkSubtle }}>{k}</dt>
                    <dd style={{ margin: `${tokens.space.xs}px 0 0`, fontSize: tokens.fontSize.sm, color: tokens.color.ink, wordBreak: "break-word", fontFamily: k === "Match ID" ? tokens.font.mono : undefined }}>
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          </>
        )}
      </AsyncView>
    </div>
  );
}
