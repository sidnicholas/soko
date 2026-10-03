"use client";

import { useState, type ReactNode } from "react";
import { Badge, Button, Card, EmptyState, PageHeader, StatCard, tokens, type Tone } from "@opportunity-os/ui";
import { api, type IntelCandidate, type IntelOutcomeInput, type IntelQueue } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const range = (r: [number, number] | null | undefined) => (r ? `${usd(r[0])}–${usd(r[1])}` : "unknown");
const words = (s: string | null | undefined) => (s ?? "").replaceAll("_", " ");

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

const LOST_REASONS = [
  "no_response",
  "stale",
  "already_sold",
  "wrong_decision_maker",
  "economics_failed",
  "supply_unavailable",
  "demand_not_genuine",
  "fee_impossible",
  "regulatory_barrier",
  "fraud",
  "competitor_won",
  "price_mismatch",
  "insufficient_trust",
  "payment_too_slow",
];

function ago(iso: string | null): string {
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

function Outreach({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md, padding: tokens.space.md, background: tokens.color.surfaceMuted }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: tokens.space.xs }}>
        <Label>{title}</Label>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div style={{ fontSize: tokens.fontSize.sm, whiteSpace: "pre-wrap", color: tokens.color.ink }}>{text}</div>
    </div>
  );
}

function StatusActions({ c, onChange }: { c: IntelCandidate; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [lostReason, setLostReason] = useState(LOST_REASONS[0]!);
  const [revenue, setRevenue] = useState("");
  async function set(body: IntelOutcomeInput) {
    setBusy(true);
    try {
      await api.setIntelStatus(c.id, body);
      onChange();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: tokens.space.sm, alignItems: "center" }}>
      <Badge tone="neutral">{words(c.user_status)}</Badge>
      <Button size="sm" disabled={busy} onClick={() => void set({ status: "contacted" })}>
        Mark contacted
      </Button>
      <Button size="sm" disabled={busy} onClick={() => void set({ status: "responded", reason: "meeting" })}>
        Got a response
      </Button>
      <input
        aria-label="Revenue received (USD)"
        placeholder="$ received"
        inputMode="decimal"
        value={revenue}
        onChange={(e) => setRevenue(e.target.value)}
        style={{ width: 96, padding: "4px 8px", border: `1px solid ${tokens.color.borderStrong}`, borderRadius: tokens.radius.sm, fontSize: tokens.fontSize.sm }}
      />
      <Button size="sm" variant="primary" disabled={busy} onClick={() => void set({ status: "won", reason: "completed", realized_usd: Number(revenue) || 0 })}>
        Won
      </Button>
      <select
        aria-label="Reason it fell through"
        value={lostReason}
        onChange={(e) => setLostReason(e.target.value)}
        style={{ padding: "4px 8px", border: `1px solid ${tokens.color.borderStrong}`, borderRadius: tokens.radius.sm, fontSize: tokens.fontSize.sm }}
      >
        {LOST_REASONS.map((r) => (
          <option key={r} value={r}>
            {words(r)}
          </option>
        ))}
      </select>
      <Button size="sm" disabled={busy} onClick={() => void set({ status: "lost", reason: lostReason })}>
        Lost
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void set({ status: "dismissed", reason: "not_relevant" })}>
        Dismiss
      </Button>
    </div>
  );
}

function CandidateDetail({ c, onChange }: { c: IntelCandidate; onChange: () => void }) {
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
        <Field label="Economics (estimates)">
          <div>You earn {range(c.economics.user_compensation_usd)}</div>
          <div style={{ color: tokens.color.inkMuted }}>
            Deal size {range(c.economics.gross_transaction_usd)} · capital {usd(c.economics.capital_required_usd)} · {c.economics.time_hours[0]}–{c.economics.time_hours[1]}h
          </div>
          <div style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}>
            P(paid) {Math.round(c.explanation.probability[0] * 100)}–{Math.round(c.explanation.probability[1] * 100)}% · {c.economics.notes}
          </div>
        </Field>
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

      {(c.outreach.primary || c.outreach.secondary) && (
        <div className="oos-stack" style={{ gap: tokens.space.sm }}>
          {c.outreach.primary && <Outreach title="Suggested outreach — review before sending" text={c.outreach.primary} />}
          {c.outreach.secondary && <Outreach title="Other side" text={c.outreach.secondary} />}
        </div>
      )}
      <StatusActions c={c} onChange={onChange} />
    </div>
  );
}

function CandidateHeader({ c }: { c: IntelCandidate }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: tokens.space.sm, alignItems: "center" }}>
      <Badge tone="accent">{MATCH_LABEL[c.match_kind]}</Badge>
      <Badge tone={VERIFICATION_TONE[c.verification_status] ?? "neutral"}>{words(c.verification_status)}</Badge>
      <Badge tone="neutral">{c.confidence} confidence</Badge>
      <span style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted, fontVariantNumeric: "tabular-nums" }}>
        EV {usd(Number(c.ev_low_usd))}–{usd(Number(c.ev_high_usd))} · score {Number(c.score).toFixed(0)} · fresh {Number(c.freshness).toFixed(2)}
      </span>
    </div>
  );
}

function Section({ title, subtitle, items, open, onChange, empty }: { title: string; subtitle: string; items: IntelCandidate[]; open: boolean; onChange: () => void; empty: string }) {
  return (
    <section className="oos-stack" style={{ gap: tokens.space.md }}>
      <div>
        <h2 style={{ margin: 0, fontSize: tokens.fontSize.lg, color: tokens.color.ink }}>
          {title} <span style={{ color: tokens.color.inkSubtle, fontWeight: 400 }}>({items.length})</span>
        </h2>
        <div style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>{subtitle}</div>
      </div>
      {items.length === 0 ? (
        <Card>
          <EmptyState compact title="Nothing here yet" description={empty} />
        </Card>
      ) : (
        items.map((c) =>
          open ? (
            <Card key={c.id} title={c.title}>
              <div className="oos-stack" style={{ gap: tokens.space.md }}>
                <CandidateHeader c={c} />
                <CandidateDetail c={c} onChange={onChange} />
              </div>
            </Card>
          ) : (
            <Card key={c.id}>
              <details>
                <summary style={{ cursor: "pointer", listStyle: "revert" }}>
                  <span style={{ fontWeight: 600, color: tokens.color.ink }}>{c.title}</span>
                  <div style={{ marginTop: tokens.space.xs }}>
                    <CandidateHeader c={c} />
                  </div>
                </summary>
                <div style={{ marginTop: tokens.space.md }}>
                  <CandidateDetail c={c} onChange={onChange} />
                </div>
              </details>
            </Card>
          ),
        )
      )}
    </section>
  );
}

function Summary({ q }: { q: IntelQueue }) {
  const s = q.stats;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: tokens.space.md }}>
      <StatCard label="Spent today" value={`$${s.spentTodayUsd.toFixed(2)}`} hint={`$${s.spentTotalUsd.toFixed(2)} total · ${s.runs} runs`} />
      <StatCard label="Leads found" value={String(s.leads)} hint={s.lastRunAt ? `last run ${ago(s.lastRunAt)}` : "no runs yet"} />
      <StatCard label="Actionable" value={String(s.actionable)} hint={s.costPerActionableUsd !== null ? `$${s.costPerActionableUsd.toFixed(2)} per actionable` : "—"} />
      <StatCard label="Contacted → won" value={`${s.contacted} → ${s.won}`} hint={`${s.responded} responded`} />
      <StatCard
        label="Portfolio EV vs target"
        value={`${usd(q.portfolio.evLowUsd)}–${usd(q.portfolio.evHighUsd)}`}
        hint={`target ${usd(q.portfolio.targetUsd)} · realized ${usd(q.portfolio.realizedUsd)}`}
      />
    </div>
  );
}

export default function QueuePage() {
  const queue = useAsync(() => api.intelQueue(), []);
  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <PageHeader
        eyebrow="Opportunity intelligence"
        title="Action Queue"
        subtitle="Signals found across the web, matched to an opposite side, verified, and tested for a real way to get paid. Nothing is sent without you."
      />
      <AsyncView state={queue} loadingLabel="Loading the queue">
        {(q) => (
          <>
            <Summary q={q} />
            <Section
              title="Act now"
              subtitle="Fresh, reachable, low-capital, with a named payer and mechanism."
              items={q.act_now}
              open
              onChange={queue.reload}
              empty="The scheduled sweep fills this when something clears every gate."
            />
            <Section title="Verify next" subtitle="Promising — one more check before outreach." items={q.verify_next} open={false} onChange={queue.reload} empty="No candidates waiting on a check." />
            <Section
              title="Watch"
              subtitle="Interesting but not ready: often an unresolved way to get paid, or no counterparty found yet."
              items={q.watch}
              open={false}
              onChange={queue.reload}
              empty="Nothing on watch."
            />
            <Card title="Rejected" subtitle="Discarded automatically; reasons are kept for learning.">
              {q.rejected.length === 0 ? (
                <EmptyState compact title="No rejections yet" description="Rejected candidates appear here with a reason code." />
              ) : (
                q.rejected.map((c) => (
                  <div key={c.id} style={{ display: "flex", justifyContent: "space-between", gap: tokens.space.md, padding: `${tokens.space.xs}px 0`, borderBottom: `1px solid ${tokens.color.border}`, fontSize: tokens.fontSize.sm }}>
                    <a href={c.lead_url} target="_blank" rel="noreferrer" className="oos-link">
                      {c.title}
                    </a>
                    <Badge tone="danger">{words(c.reject_reason)}</Badge>
                  </div>
                ))
              )}
            </Card>
            <Card title="Query yield" subtitle="What each discovery search produced. Prune queries that never yield leads; add variety where they do.">
              {q.queries.length === 0 ? (
                <EmptyState compact title="No runs yet" description="Each scheduled run records results, new pages, leads and actionable candidates per query." />
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: tokens.fontSize.sm }}>
                    <thead>
                      <tr style={{ color: tokens.color.inkSubtle, textAlign: "right" }}>
                        <th style={{ textAlign: "left", padding: `${tokens.space.xs}px 0`, fontWeight: 500 }}>Query</th>
                        {["Runs", "Results", "New", "Leads", "Assessed", "Actionable"].map((h) => (
                          <th key={h} style={{ padding: `${tokens.space.xs}px ${tokens.space.sm}px`, fontWeight: 500 }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {q.queries.map((r) => (
                        <tr key={r.query} style={{ borderTop: `1px solid ${tokens.color.border}` }}>
                          <td style={{ padding: `${tokens.space.xs}px 0`, color: r.leads === 0 ? tokens.color.inkSubtle : tokens.color.ink }}>{r.query}</td>
                          {[r.searches, r.results, r.new_results, r.leads, r.assessed, r.actionable].map((n, i) => (
                            <td key={i} style={{ padding: `${tokens.space.xs}px ${tokens.space.sm}px`, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: i === 5 && n > 0 ? 600 : 400 }}>
                              {n}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <Card title="Sources" subtitle="Every site a lead came from, by yield (actionable ÷ leads).">
              {q.sources.length === 0 ? (
                <EmptyState compact title="No sources yet" description="Sites register automatically as leads are found." />
              ) : (
                q.sources.map((s) => (
                  <div key={s.hostname} style={{ display: "flex", justifyContent: "space-between", padding: `${tokens.space.xs}px 0`, borderBottom: `1px solid ${tokens.color.border}`, fontSize: tokens.fontSize.sm }}>
                    <span>
                      {s.hostname} <span style={{ color: tokens.color.inkSubtle }}>{s.orientation}</span>
                    </span>
                    <span style={{ fontVariantNumeric: "tabular-nums", color: tokens.color.inkMuted }}>
                      {s.actionable}/{s.leads}
                    </span>
                  </div>
                ))
              )}
            </Card>
          </>
        )}
      </AsyncView>
    </div>
  );
}
