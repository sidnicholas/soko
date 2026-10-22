"use client";

import { useState, type ReactNode } from "react";
import { Badge, Button, tokens, type Tone } from "@opportunity-os/ui";
import { api, type DealEconomics, type IntelCandidate } from "../lib/api";
import { useAsync } from "../lib/useAsync";

/** A candidate's facts, economics, scoring and evidence, shared by the Action Queue and Follow-ups. */

export const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const range = (r: [number, number] | null | undefined) => (r ? `${usd(r[0])}–${usd(r[1])}` : "unknown");
export const words = (s: string | null | undefined) => (s ?? "").replaceAll("_", " ");

const VERIFICATION_TONE: Record<string, Tone> = {
  verified: "success",
  strongly_supported: "success",
  plausible: "info",
  speculative: "warning",
  rejected: "danger",
};

const MATCH_LABEL: Record<IntelCandidate["match_kind"], string> = {
  problem_to_service: "Problem → your service",
  demand_to_supply: "Demand → supply",
  supply_to_demand: "Supply → demand",
};

export function ago(iso: string | null): string {
  if (!iso) return "date unknown";
  const hours = Math.max(0, (Date.now() - Date.parse(iso)) / 3_600_000);
  return hours < 48 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`;
}

function Label({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 2 }}>{children}</div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      <div style={{ fontSize: tokens.fontSize.sm, color: tokens.color.ink, lineHeight: 1.45 }}>{children}</div>
    </div>
  );
}

/** What it is, who pays, the economics, contact path, risks, why it scored, and the evidence behind it. */
export function CandidateFacts({ c }: { c: IntelCandidate }) {
  const m = c.monetization;
  const risks = [...c.regulatory_flags.map((f) => ({ ...f, kind: "Regulatory" })), ...c.fraud_flags.map((f) => ({ ...f, kind: "Fraud" }))];
  return (
    <div className="oos-stack" style={{ gap: tokens.space.lg }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: tokens.space.lg }}>
        <Field label="Signal (source)">
          <a href={c.lead_url} target="_blank" rel="noreferrer" className="oos-link">
            {c.lead_title}
          </a>
          <div style={{ color: tokens.color.inkMuted }}>{c.lead_summary}</div>
          <div style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}>
            {c.lead_hostname} · posted {c.lead_age_text ?? ago(c.lead_published_at)} · found {ago(c.lead_discovered_at)} · query “{c.lead_query}”
          </div>
        </Field>
        <Field label={c.match_kind === "problem_to_service" ? "Your service" : "Other side"}>
          {c.counter_url ? (
            <a href={c.counter_url} target="_blank" rel="noreferrer" className="oos-link">
              {c.counter_summary ?? c.counter_url}
            </a>
          ) : (
            c.counter_summary ?? <span style={{ color: tokens.color.inkSubtle }}>None found</span>
          )}
          <div style={{ color: tokens.color.inkMuted, marginTop: 4 }}>{c.match_rationale}</div>
        </Field>
        <Field label="Why do we get paid?">
          {m.resolved ? (
            <>
              <div>
                <strong>{m.payer}</strong> pays a {words(m.mechanism)}
                {m.timing ? `, ${m.timing}` : ""}.
              </div>
              <div style={{ color: tokens.color.inkMuted }}>Value added: {m.valueAdded}</div>
            </>
          ) : (
            <span style={{ color: tokens.color.inkMuted }}>{m.note ?? "Monetization unresolved"}</span>
          )}
        </Field>
        {c.economics.deal ? (
          <DealBreakdown d={c.economics.deal} />
        ) : (
        <Field label="Economics (estimates)">
          <div>You earn {range(c.economics.user_compensation_usd)}</div>
          <div style={{ color: tokens.color.inkMuted }}>
            Deal size {range(c.economics.gross_transaction_usd)} · capital {usd(c.economics.capital_required_usd)} · {c.economics.time_hours[0]}–{c.economics.time_hours[1]}h
          </div>
          <div style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}>
            P(paid) {Math.round(c.explanation.probability[0] * 100)}–{Math.round(c.explanation.probability[1] * 100)}% · {c.economics.notes}
          </div>
        </Field>
        )}
        <Field label="Contact path">
          {c.contact && c.contact.channel !== "unknown" ? (
            <>
              {words(c.contact.channel)}
              {c.contact.value ? `: ${c.contact.value}` : ""} <span style={{ color: tokens.color.inkSubtle }}>({words(c.contact.label)})</span>
            </>
          ) : (
            <span style={{ color: tokens.color.inkSubtle }}>Not found yet</span>
          )}
        </Field>
        <Field label="Risks">
          {risks.length === 0 ? (
            <span style={{ color: tokens.color.inkSubtle }}>None flagged</span>
          ) : (
            risks.map((r) => (
              <div key={r.flag}>
                <Badge tone={r.kind === "Fraud" ? "danger" : "warning"}>{words(r.flag)}</Badge> <span style={{ color: tokens.color.inkMuted }}>{r.reason}</span>
              </div>
            ))
          )}
        </Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: tokens.space.lg }}>
        <Field label={`Why score ${Number(c.score).toFixed(0)}`}>
          {c.explanation.factors.map((f) => (
            <div key={f.name} style={{ display: "flex", justifyContent: "space-between", gap: tokens.space.sm }}>
              <span style={{ color: tokens.color.inkMuted }}>
                {words(f.name)} <span style={{ color: tokens.color.inkSubtle }}>— {f.note}</span>
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums", color: f.points < 0 ? tokens.color.dangerBorder : tokens.color.ink }}>
                {f.points > 0 ? "+" : ""}
                {f.points.toFixed(1)}
              </span>
            </div>
          ))}
        </Field>
        <Field label="What would invalidate this">
          {c.explanation.invalidators.length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {c.explanation.invalidators.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          ) : (
            <span style={{ color: tokens.color.inkSubtle }}>None given</span>
          )}
        </Field>
      </div>

      <Evidence id={c.id} />
    </div>
  );
}

const TIER_TONE: Record<DealEconomics["tier"], Tone> = { high: "success", medium: "success", low: "info", marginal: "warning", negative: "danger" };
const days = (r: [number, number]) => `${Math.round(r[0])}–${Math.round(r[1])} days`;
const pct = (r: [number, number]) => `${Math.round(r[0] * 100)}–${Math.round(r[1] * 100)}%`;

/** PRD v2 §2: profit, probability of close and time to cash shown separately, never one blended number. */
function DealMeasures({ d }: { d: DealEconomics }) {
  return (
    <span style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted, fontVariantNumeric: "tabular-nums" }}>
      <Badge tone={TIER_TONE[d.tier]}>{d.tier} profit</Badge> net {range(d.netProfitUsd)} · P(close) {pct(d.probability)} · cash in {days(d.daysToCash)}
      {d.gates.length > 0 && <> · {d.gates.map((g) => <Badge key={g} tone="danger">{words(g)}</Badge>)}</>}
    </span>
  );
}

/** Revenue, spread, every cost line and its basis, net, capital, expected profit (PRD v2 FR-04). */
function DealBreakdown({ d }: { d: DealEconomics }) {
  return (
    <Field label={`Deal economics · ${d.mode}`}>
      <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "2px 12px", fontVariantNumeric: "tabular-nums", fontSize: tokens.fontSize.sm }}>
        {d.grossRevenueUsd && (
          <>
            <span style={{ color: tokens.color.inkMuted }}>Deal size</span>
            <span>{range(d.grossRevenueUsd)}</span>
          </>
        )}
        <span style={{ color: tokens.color.inkMuted }}>{d.mode === "principal" ? "Gross spread" : "Your fee"}</span>
        <span>{range(d.grossSpreadUsd)}</span>
        {d.costs.map((c, i) => (
          <span key={`${c.kind}-${i}`} style={{ display: "contents" }}>
            <span style={{ color: tokens.color.inkSubtle }}>
              − {words(c.kind)} <span style={{ fontSize: tokens.fontSize.xs }}>({c.label === "default_assumption" ? `assumed: ${c.note ?? ""}` : words(c.label)})</span>
            </span>
            <span style={{ color: tokens.color.inkMuted }}>{range(c.usd)}</span>
          </span>
        ))}
        <span style={{ fontWeight: 600 }}>Net profit</span>
        <span style={{ fontWeight: 600, color: d.netProfitUsd[1] <= 0 ? "#b02525" : tokens.color.ink }}>{range(d.netProfitUsd)}</span>
        <span style={{ color: tokens.color.inkMuted }}>Expected (× P close {pct(d.probability)})</span>
        <span>{range(d.expectedProfitUsd)}</span>
        <span style={{ color: tokens.color.inkMuted }}>Capital · cash in</span>
        <span>
          {usd(d.capitalRequiredUsd)} · {days(d.daysToCash)}
        </span>
      </div>
    </Field>
  );
}

/** What the candidate rests on, as captured, with the content hash for reproducing it. */
function Evidence({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const detail = useAsync(() => (open ? api.intelCandidate(id) : Promise.resolve(null)), [open, id]);
  return (
    <div>
      <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
        {open ? "Hide evidence" : "Show evidence and economics history"}
      </Button>
      {open && detail.data && (
        <div style={{ marginTop: tokens.space.sm, fontSize: tokens.fontSize.sm }} className="oos-stack">
          {detail.data.evidence.map((e) => (
            <div key={e.id} style={{ borderBottom: `1px solid ${tokens.color.border}`, padding: `${tokens.space.xs}px 0` }}>
              <Badge tone={e.label === "source_fact" ? "success" : "warning"}>{words(e.kind)}</Badge>{" "}
              {e.url ? (
                <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="oos-link">
                  {e.title ?? e.url}
                </a>
              ) : (
                e.title
              )}
              {e.excerpt && <div style={{ color: tokens.color.inkMuted }}>{e.excerpt}</div>}
              <div style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}>
                {words(e.label)} · captured {e.captured_at.slice(0, 16).replace("T", " ")} · sha256 {e.content_hash.slice(0, 12)}
              </div>
            </div>
          ))}
          {detail.data.economics_versions.length > 0 && (
            <div style={{ color: tokens.color.inkMuted, fontSize: tokens.fontSize.xs }}>
              Economics versions: {detail.data.economics_versions.map((v) => `v${v.version} ${v.tier}${v.gates.length ? ` (${v.gates.map(words).join(", ")})` : ""} ${v.created_at.slice(0, 10)}`).join(" · ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function CandidateHeader({ c }: { c: IntelCandidate }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: tokens.space.sm, alignItems: "center" }}>
      {c.economics.deal && <DealMeasures d={c.economics.deal} />}
      <Badge tone="accent">{MATCH_LABEL[c.match_kind]}</Badge>
      <Badge tone={VERIFICATION_TONE[c.verification_status] ?? "neutral"}>{words(c.verification_status)}</Badge>
      <Badge tone="neutral">{c.confidence} confidence</Badge>
      <span style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted, fontVariantNumeric: "tabular-nums" }}>
        EV {usd(Number(c.ev_low_usd))}–{usd(Number(c.ev_high_usd))} · score {Number(c.score).toFixed(0)} · fresh {Number(c.freshness).toFixed(2)}
      </span>
    </div>
  );
}
