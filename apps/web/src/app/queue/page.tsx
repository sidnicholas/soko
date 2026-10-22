"use client";

import { useState } from "react";
import { Badge, Button, Card, EmptyState, PageHeader, StatCard, tokens } from "@opportunity-os/ui";
import { api, type IntelCandidate, type IntelOutcomeInput, type IntelQueue, type RankingProfile } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";
import { SubjectContacts } from "../../components/Contacts";
import { SuggestedOutreach } from "../../components/SuggestedOutreach";
import { CandidateFacts, CandidateHeader, ago, usd, words } from "../../components/CandidateFacts";
import Link from "next/link";

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


/** Elevate to Pipedrive, or show where the deal is (ADR-040). */
function PipedriveAction({ c, onChange }: { c: IntelCandidate; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (c.crm_url) {
    return (
      <div style={{ fontSize: tokens.fontSize.sm }}>
        <Badge tone={c.crm_status === "won" ? "success" : c.crm_status === "lost" || c.crm_status === "deleted" ? "danger" : "info"}>Pipedrive: {c.crm_status}</Badge>{" "}
        <a href={c.crm_url} target="_blank" rel="noopener noreferrer" className="oos-link">
          Open the deal
        </a>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap" }}>
      <Button
        size="sm"
        variant="secondary"
        loading={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          api
            .elevateToPipedrive(c.id)
            .then(onChange)
            .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not send to Pipedrive"))
            .finally(() => setBusy(false));
        }}
      >
        Send to Pipedrive
      </Button>
      {error && <span style={{ fontSize: tokens.fontSize.xs, color: "#b02525" }}>{error}</span>}
    </div>
  );
}

/** Reasons offered when dismissing: the codes the API accepts, most common first. */
const DISMISS_REASONS = ["not_relevant", "demand_not_genuine", "economics_failed", "price_mismatch", "fee_impossible", "supply_unavailable", "stale", "regulatory_barrier", "fraud"];

function StatusActions({ c, onChange }: { c: IntelCandidate; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [lostReason, setLostReason] = useState(LOST_REASONS[0]!);
  const [revenue, setRevenue] = useState("");
  // Dismiss and Lost open a short form so the why is written down, not only a code.
  const [closing, setClosing] = useState<"dismissed" | "lost" | null>(null);
  const [dismissReason, setDismissReason] = useState(DISMISS_REASONS[0]!);
  const [note, setNote] = useState("");
  async function set(body: IntelOutcomeInput) {
    setBusy(true);
    try {
      await api.setIntelStatus(c.id, body);
      onChange();
    } finally {
      setBusy(false);
    }
  }
  const control = { padding: "4px 8px", border: `1px solid ${tokens.color.borderStrong}`, borderRadius: tokens.radius.sm, fontSize: tokens.fontSize.sm } as const;
  return (
    <div className="oos-stack" style={{ gap: tokens.space.sm }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: tokens.space.sm, alignItems: "center" }}>
        <Badge tone="neutral">{words(c.user_status)}</Badge>
        <Button size="sm" disabled={busy} onClick={() => void set({ status: "contacted" })}>
          Mark contacted
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void set({ status: "responded", reason: "meeting" })}>
          Got a response
        </Button>
        <input aria-label="Revenue received (USD)" placeholder="$ received" inputMode="decimal" value={revenue} onChange={(e) => setRevenue(e.target.value)} style={{ ...control, width: 96 }} />
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void set({ status: "won", reason: "completed", realized_usd: Number(revenue) || 0 })}>
          Won
        </Button>
        <Button size="sm" disabled={busy} variant={closing === "lost" ? "secondary" : undefined} onClick={() => setClosing(closing === "lost" ? null : "lost")}>
          Lost…
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setClosing(closing === "dismissed" ? null : "dismissed")}>
          Dismiss…
        </Button>
      </div>
      {closing && (
        <div style={{ display: "flex", flexDirection: "column", gap: tokens.space.xs, maxWidth: 560 }}>
          <label style={{ fontSize: tokens.fontSize.sm, color: tokens.color.ink }}>
            {closing === "dismissed" ? "Why dismiss it?" : "Why was it lost?"}{" "}
            <select
              aria-label={closing === "dismissed" ? "Dismiss reason" : "Reason it fell through"}
              value={closing === "dismissed" ? dismissReason : lostReason}
              onChange={(e) => (closing === "dismissed" ? setDismissReason(e.target.value) : setLostReason(e.target.value))}
              style={control}
            >
              {(closing === "dismissed" ? DISMISS_REASONS : LOST_REASONS).map((r) => (
                <option key={r} value={r}>
                  {words(r)}
                </option>
              ))}
            </select>
          </label>
          <textarea
            aria-label="Summary"
            placeholder="Summary: what you found and why it is not worth pursuing (kept for learning)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={2000}
            style={{ ...control, fontFamily: "inherit", resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: tokens.space.sm }}>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => void set({ status: closing, reason: closing === "dismissed" ? dismissReason : lostReason, note: note.trim() || null }).then(() => setClosing(null))}
            >
              {closing === "dismissed" ? "Dismiss" : "Mark lost"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setClosing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <PipedriveAction c={c} onChange={onChange} />
      {c.outcome_note && (
        <div style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>
          Note: {c.outcome_note}
        </div>
      )}
    </div>
  );
}

function CandidateDetail({ c, onChange }: { c: IntelCandidate; onChange: () => void }) {
  return (
    <div className="oos-stack" style={{ gap: tokens.space.lg }}>
      <CandidateFacts c={c} />

      <SubjectContacts
        subjectType="intel_candidate"
        subjectId={c.id}
        defaults={{
          email: c.contact?.channel === "email" ? (c.contact.value ?? "") : "",
          phone: c.contact?.channel === "phone" ? (c.contact.value ?? "") : "",
          // The lead is the side the signal came from: supply is selling; demand and problems are buying.
          role: c.match_kind === "supply_to_demand" ? "seller" : "buyer",
          sourceType: "candidate",
          sourceUrl: c.lead_url,
        }}
      />

      {(c.outreach.primary || c.outreach.secondary) && (
        <div className="oos-stack" style={{ gap: tokens.space.sm }}>
          {c.outreach.primary && <SuggestedOutreach title="Suggested outreach — review before sending" text={c.outreach.primary} />}
          {c.outreach.secondary && <SuggestedOutreach title="Other side" text={c.outreach.secondary} />}
        </div>
      )}
      <StatusActions c={c} onChange={onChange} />
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

const RANKS: { value: RankingProfile; label: string }[] = [
  { value: "profit_first", label: "Profit first" },
  { value: "expected_value", label: "Expected value" },
  { value: "fastest_cash", label: "Fastest cash" },
];

export default function QueuePage() {
  const [rank, setRank] = useState<RankingProfile>("profit_first");
  const queue = useAsync(() => api.intelQueue(rank), [rank]);
  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <PageHeader
        eyebrow="Opportunity intelligence"
        title="Action Queue"
        subtitle="Signals found across the web, matched to an opposite side, verified, and tested for a real way to get paid. Nothing is sent without you."
        actions={
          <div style={{ display: "flex", gap: tokens.space.xs }} role="group" aria-label="Ranking">
            {RANKS.map((r) => (
              <Button key={r.value} size="sm" variant={r.value === rank ? "primary" : "secondary"} aria-pressed={r.value === rank} onClick={() => setRank(r.value)}>
                {r.label}
              </Button>
            ))}
          </div>
        }
      />
      <AsyncView state={queue} loadingLabel="Loading the queue">
        {(q) => (
          <>
            <Summary q={q} />
            {q.follow_ups && q.follow_ups.due + q.follow_ups.stalled + q.follow_ups.cold + q.follow_ups.upcoming > 0 && (
              <Card>
                <div style={{ display: "flex", gap: tokens.space.md, alignItems: "center", flexWrap: "wrap", fontSize: tokens.fontSize.sm }}>
                  <span>
                    <strong>{q.follow_ups.due} follow-up{q.follow_ups.due === 1 ? "" : "s"} due</strong>
                    {q.follow_ups.stalled ? ` · ${q.follow_ups.stalled} stalled` : ""}
                    {q.follow_ups.cold ? ` · ${q.follow_ups.cold} gone cold` : ""} · {q.follow_ups.upcoming} waiting. Contacted candidates are worked from Follow-ups.
                  </span>
                  <Link href="/follow-ups" className="oos-link">
                    Open Follow-ups
                  </Link>
                </div>
              </Card>
            )}
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
            <Card title="Sources" subtitle="Where these searches run is managed in the Source Registry: review new sources, pause or resume, and see each one's cost and yield.">
              <Link href="/sources" className="oos-link">
                Open the Source Registry
              </Link>
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
                        {["Runs", "Results", "New", "Leads", "Assessed", "Actionable", "Why not leads"].map((h) => (
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
                          <td style={{ padding: `${tokens.space.xs}px ${tokens.space.sm}px`, textAlign: "right", color: tokens.color.inkMuted, fontSize: tokens.fontSize.xs }}>
                            {Object.entries(r.reasons ?? {})
                              .sort((a, b) => b[1] - a[1])
                              .slice(0, 3)
                              .map(([reason, n]) => `${words(reason)} ${n}`)
                              .join(" · ") || "—"}
                          </td>
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
