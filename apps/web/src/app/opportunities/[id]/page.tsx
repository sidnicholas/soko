"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  PageHeader,
  StatCard,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatScore,
  statusLabel,
  tokens,
  tonePalette,
  type Tone,
} from "@opportunity-os/ui";
import { api, type OpportunityDetail, type OpportunityDetails, type OpportunityParty, type OpportunitySide } from "../../../lib/api";
import { useAsync } from "../../../lib/useAsync";
import { AsyncView } from "../../../components/AsyncView";
import { AssistantChat } from "../../../components/AssistantChat";
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

/** Display names for the connector and channel ids records carry as `source_id`. */
const PLATFORM_LABELS: Record<string, string> = {
  ebay: "eBay",
  reverb: "Reverb",
  mission: "Mission (entered in Opportunity OS)",
  sms: "SMS",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  email: "Email",
};

function platformLabel(id: string): string {
  return PLATFORM_LABELS[id] ?? id;
}

const labelStyle = { fontSize: tokens.fontSize.xs, textTransform: "uppercase", letterSpacing: "0.04em", color: tokens.color.inkSubtle } as const;
const valueStyle = { margin: `${tokens.space.xs}px 0 0`, fontSize: tokens.fontSize.sm, color: tokens.color.ink, wordBreak: "break-word" } as const;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt style={labelStyle}>{label}</dt>
      <dd style={valueStyle}>{children}</dd>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="oos-link">
      {children}
    </a>
  );
}

function PartyDetails({ party }: { party: OpportunityParty }) {
  const dash = <span style={{ color: tokens.color.inkSubtle }}>Not provided by the source</span>;
  return (
    <div className="oos-stack" style={{ gap: tokens.space.md }}>
      <div>
        <div style={{ fontWeight: 600, color: tokens.color.ink }}>
          {party.url ? <ExternalLink href={party.url}>{party.title}</ExternalLink> : party.title}
        </div>
        {party.summary && party.summary !== party.title && (
          <p style={{ margin: `${tokens.space.xs}px 0 0`, fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted, whiteSpace: "pre-wrap" }}>{party.summary}</p>
        )}
      </div>
      <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: tokens.space.md, margin: 0 }}>
        <Field label={party.kind === "supply" ? "Seller" : "Buyer"}>
          {party.counterparty ? (
            <>
              {party.counterparty.url ? <ExternalLink href={party.counterparty.url}>{party.counterparty.name}</ExternalLink> : party.counterparty.name}
              {party.counterparty.detail && <div style={{ color: tokens.color.inkMuted }}>{party.counterparty.detail}</div>}
            </>
          ) : party.mission ? (
            "Mission owner"
          ) : (
            dash
          )}
        </Field>
        <Field label="Platform">
          {platformLabel(party.platform)}
          {party.signal && <div style={{ color: tokens.color.inkMuted }}>via {party.signal.channel}, {formatDateTime(party.signal.captured_at)}</div>}
        </Field>
        <Field label={party.price_label}>{formatMoney(party.price)}</Field>
        <Field label="Location">{party.location ?? dash}</Field>
        {party.condition && <Field label="Condition">{party.condition}</Field>}
        {party.quantity !== null && <Field label="Quantity">{party.quantity}</Field>}
        {party.category && <Field label="Category">{party.category}</Field>}
        {party.needed_by && <Field label="Needed by">{formatDateTime(party.needed_by)}</Field>}
        {party.mission && (
          <Field label="Mission">
            <Link href={`/missions/${party.mission.id}`} className="oos-link">
              {party.mission.title}
            </Link>
          </Field>
        )}
        <Field label="Listing">
          {party.url ? <ExternalLink href={party.url}>Open on {platformLabel(party.platform)}</ExternalLink> : party.kind === "supply" ? dash : "No public listing"}
          {party.external_ref && <div style={{ color: tokens.color.inkMuted, fontFamily: tokens.font.mono, fontSize: tokens.fontSize.xs }}>{party.external_ref}</div>}
        </Field>
        <Field label="Availability">
          {statusLabel(party.availability)}
          <div style={{ color: tokens.color.inkMuted }}>Verified {formatDateTime(party.last_verified_at, { dash: "never" })}</div>
        </Field>
      </dl>
    </div>
  );
}

function SideCard({ side }: { side: OpportunitySide }) {
  return (
    <Card title={side.label} subtitle={side.note ?? undefined}>
      {side.parties.length === 0 ? (
        <p style={{ margin: 0, fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>No {side.role} record is linked to this opportunity.</p>
      ) : (
        <div className="oos-stack" style={{ gap: tokens.space.lg }}>
          {side.parties.map((p, i) => (
            <div key={p.id} style={i > 0 ? { borderTop: `1px solid ${tokens.color.border}`, paddingTop: tokens.space.lg } : undefined}>
              <PartyDetails party={p} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function MatchCard({ match }: { match: NonNullable<OpportunityDetails["match"]> }) {
  const yesNo = (v: boolean | null) => (v === null ? "Unknown" : v ? "Yes" : "No");
  return (
    <Card title="Why they matched" subtitle="Match scores from 0 to 1, higher is better.">
      <div className="oos-stack" style={{ gap: tokens.space.md }}>
        {match.rationale && <p style={{ margin: 0, fontSize: tokens.fontSize.sm, color: tokens.color.ink }}>{match.rationale}</p>}
        <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: tokens.space.md, margin: 0 }}>
          <Field label="Same category">{yesNo(match.category_aligned)}</Field>
          <Field label="Within budget">{yesNo(match.within_budget)}</Field>
          <Field label="Shared terms">{match.shared_terms.length > 0 ? match.shared_terms.join(", ") : "None"}</Field>
        </dl>
        <ScoreMeter label="Match total" value={match.scores.total} tone={scoreTone(match.scores.total)} />
        <ScoreMeter label="Description similarity" value={match.scores.semantic} tone={scoreTone(match.scores.semantic)} />
        <ScoreMeter label="Constraints" value={match.scores.constraint} tone={scoreTone(match.scores.constraint)} />
        <ScoreMeter label="Geography" value={match.scores.geography} tone={scoreTone(match.scores.geography)} />
        <ScoreMeter label="Timing" value={match.scores.timing} tone={scoreTone(match.scores.timing)} />
        <ScoreMeter label="Quality" value={match.scores.quality} tone={scoreTone(match.scores.quality)} />
      </div>
    </Card>
  );
}

export default function OpportunityDetailPage({ params }: { params: { id: string } }) {
  const state = useAsync<OpportunityDetail>(() => api.getOpportunity(params.id), [params.id]);
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

            {o.details && o.details.sides.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: tokens.space.lg }}>
                {o.details.sides.map((side) => (
                  <SideCard key={side.label} side={side} />
                ))}
              </div>
            )}

            {o.details?.match && <MatchCard match={o.details.match} />}

            <Card title="Assistant" subtitle="Talk this deal through with Claude, Perplexity, You.com or OpenAI. The conversation is saved here.">
              <AssistantChat subject="opportunities" id={o.id} defaultOpen />
            </Card>

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
