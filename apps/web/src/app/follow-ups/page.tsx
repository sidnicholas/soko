"use client";

import { useState } from "react";
import { Badge, Button, Card, EmptyState, PageHeader, Select, StatCard, Textarea, tokens, type Tone } from "@opportunity-os/ui";
import { api, type ClosedCandidate, type FollowUpItem, type FollowUpStage, type TouchChannel } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";
import { SubjectContacts } from "../../components/Contacts";

/**
 * Follow-ups (ADR-047): candidates marked contacted or responded leave the
 * Action Queue and age here on a follow-up cadence; won, lost and dismissed
 * ones are the closed archive.
 */

const words = (s: string | null | undefined) => (s ?? "").replaceAll("_", " ");
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);
const DAY = 86_400_000;

function ago(iso: string): string {
  const d = (Date.now() - Date.parse(iso)) / DAY;
  if (d < 1) return `${Math.max(0, Math.round(d * 24))}h ago`;
  return `${Math.round(d)}d ago`;
}

/** "today", "in 2d", "1d overdue". */
function dueText(iso: string): string {
  const d = (Date.parse(iso) - Date.now()) / DAY;
  if (d <= 0) return d > -1 ? "due now" : `${Math.round(-d)}d overdue`;
  if (d < 1) return `in ${Math.max(1, Math.round(d * 24))}h`;
  return `in ${Math.round(d)}d (${new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })})`;
}

const STAGE_TONE: Record<FollowUpStage, Tone> = { due: "warning", stalled: "danger", cold: "neutral", upcoming: "info" };
const STAGE_LABEL: Record<FollowUpStage, string> = { due: "due", stalled: "stalled", cold: "gone cold", upcoming: "waiting" };
const CHANNELS: TouchChannel[] = ["email", "phone", "text", "platform_message", "in_person", "other"];
const LOST_REASONS = ["no_response", "already_sold", "price_mismatch", "economics_failed", "wrong_decision_maker", "competitor_won", "insufficient_trust", "supply_unavailable", "demand_not_genuine", "stale"];
const TOUCH_LABEL: Record<string, string> = { contacted: "First contact", follow_up: "Follow-up", responded: "Response", note: "Note" };

function FollowUpCard({ f, onChange }: { f: FollowUpItem; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<"follow_up" | "note" | "lost" | "won" | null>(null);
  const [channel, setChannel] = useState<TouchChannel>(f.contact?.channel && CHANNELS.includes(f.contact.channel as TouchChannel) ? (f.contact.channel as TouchChannel) : "platform_message");
  const [note, setNote] = useState("");
  const [lostReason, setLostReason] = useState(f.plan.stage === "cold" ? "no_response" : LOST_REASONS[0]!);
  const [revenue, setRevenue] = useState("");
  const p = f.plan;

  async function act(fn: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setForm(null);
      setNote("");
      onChange();
    } catch (err) {
      setError(errorText(err, fallback));
    } finally {
      setBusy(false);
    }
  }
  const snooze = (days: number) => act(() => api.snoozeCandidate(f.id, new Date(Date.now() + days * DAY).toISOString()), "Could not snooze");

  return (
    <Card>
      <div id={f.id} className="oos-stack" style={{ gap: tokens.space.sm, scrollMarginTop: 80 }}>
        <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, color: tokens.color.ink }}>{f.title}</span>
          <Badge tone={STAGE_TONE[p.stage]}>{p.snoozed ? "snoozed" : STAGE_LABEL[p.stage]}</Badge>
          <Badge tone={f.user_status === "responded" ? "success" : "neutral"}>{f.user_status}</Badge>
        </div>
        <div style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>
          First contact {ago(p.firstContactAt)} · {p.outboundTouches} {p.outboundTouches === 1 ? "touch" : "touches"} sent · last touch {ago(p.lastTouchAt)}
          {p.nextAt && <> · {p.stage === "upcoming" && !p.step && !p.snoozed && f.user_status === "contacted" ? "goes cold" : p.snoozed ? "reminder" : "next"} {dueText(p.nextAt)}</>}
        </div>
        <div style={{ border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md, padding: tokens.space.sm, background: tokens.color.surfaceMuted, fontSize: tokens.fontSize.sm }}>
          <strong>{p.action}.</strong> {p.guidance}
        </div>
        <div style={{ fontSize: tokens.fontSize.sm, display: "flex", gap: tokens.space.md, flexWrap: "wrap" }}>
          <a href={f.lead_url} target="_blank" rel="noopener noreferrer" className="oos-link">
            {f.lead_hostname}: {f.lead_title}
          </a>
          {f.counter_url && (
            <a href={f.counter_url} target="_blank" rel="noopener noreferrer" className="oos-link">
              Other side
            </a>
          )}
          {f.contact && f.contact.channel !== "unknown" && (
            <span style={{ color: tokens.color.inkMuted }}>
              Contact: {words(f.contact.channel)}
              {f.contact.value ? ` ${f.contact.value}` : ""}
            </span>
          )}
          <span style={{ color: tokens.color.inkMuted }}>
            EV {usd(f.ev_low_usd)}–{usd(f.ev_high_usd)}
          </span>
          {f.crm_url && (
            <a href={f.crm_url} target="_blank" rel="noopener noreferrer" className="oos-link">
              Pipedrive deal
            </a>
          )}
        </div>

        <div style={{ display: "flex", gap: tokens.space.sm, flexWrap: "wrap", alignItems: "center" }}>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => setForm(form === "follow_up" ? null : "follow_up")}>
            Log follow-up
          </Button>
          {f.user_status === "contacted" && (
            <Button size="sm" disabled={busy} onClick={() => void act(() => api.logTouch(f.id, { kind: "responded" }), "Could not record the response")}>
              Got a response
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm(form === "note" ? null : "note")}>
            Add note
          </Button>
          <span style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>Remind me in</span>
          {[1, 3, 7].map((d) => (
            <Button key={d} size="sm" variant="ghost" disabled={busy} onClick={() => void snooze(d)}>
              {d === 7 ? "1w" : `${d}d`}
            </Button>
          ))}
          {p.snoozed && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api.snoozeCandidate(f.id, null), "Could not clear the reminder")}>
              Clear reminder
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={() => setForm(form === "won" ? null : "won")}>
            Won
          </Button>
          <Button size="sm" disabled={busy} variant={p.stage === "cold" ? "secondary" : undefined} onClick={() => setForm(form === "lost" ? null : "lost")}>
            {p.stage === "cold" ? "Close as lost…" : "Lost…"}
          </Button>
        </div>

        {(form === "follow_up" || form === "note") && (
          <div className="oos-stack" style={{ gap: tokens.space.xs, maxWidth: 560 }}>
            {form === "follow_up" && (
              <label style={{ fontSize: tokens.fontSize.sm }}>
                How?{" "}
                <Select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as TouchChannel)} style={{ width: "auto" }}>
                  {CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {words(c)}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <Textarea aria-label="Note" rows={2} maxLength={2000} placeholder={form === "note" ? "What happened, what was agreed" : "Optional: what you said"} value={note} onChange={(e) => setNote(e.target.value)} />
            <div style={{ display: "flex", gap: tokens.space.sm }}>
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                disabled={form === "note" && !note.trim()}
                onClick={() => void act(() => api.logTouch(f.id, form === "note" ? { kind: "note", note } : { kind: "follow_up", channel, note: note.trim() || null }), "Could not save")}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                Cancel
              </Button>
            </div>
            {form === "follow_up" && f.user_status === "contacted" && <div style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>Emails approved in the Outreach Inbox about this candidate are logged automatically.</div>}
          </div>
        )}
        {form === "won" && (
          <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap" }}>
            <input aria-label="Revenue received (USD)" placeholder="$ received" inputMode="decimal" value={revenue} onChange={(e) => setRevenue(e.target.value)} style={{ padding: "4px 8px", border: `1px solid ${tokens.color.borderStrong}`, borderRadius: tokens.radius.sm, width: 110 }} />
            <Button size="sm" variant="primary" loading={busy} onClick={() => void act(() => api.setIntelStatus(f.id, { status: "won", reason: "completed", realized_usd: Number(revenue) || 0 }), "Could not save")}>
              Mark won
            </Button>
          </div>
        )}
        {form === "lost" && (
          <div className="oos-stack" style={{ gap: tokens.space.xs, maxWidth: 560 }}>
            <label style={{ fontSize: tokens.fontSize.sm }}>
              Why?{" "}
              <Select aria-label="Reason it fell through" value={lostReason} onChange={(e) => setLostReason(e.target.value)} style={{ width: "auto" }}>
                {LOST_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {words(r)}
                  </option>
                ))}
              </Select>
            </label>
            <Textarea aria-label="Summary" rows={2} maxLength={2000} placeholder="Summary (kept for learning)" value={note} onChange={(e) => setNote(e.target.value)} />
            <div>
              <Button size="sm" variant="primary" loading={busy} onClick={() => void act(() => api.setIntelStatus(f.id, { status: "lost", reason: lostReason, note: note.trim() || null }), "Could not save")}>
                Mark lost
              </Button>
            </div>
          </div>
        )}
        {error && <div style={{ fontSize: tokens.fontSize.xs, color: "#b02525" }}>{error}</div>}

        <details>
          <summary style={{ cursor: "pointer", fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>History, contacts and suggested wording</summary>
          <div className="oos-stack" style={{ gap: tokens.space.md, marginTop: tokens.space.sm }}>
            <div style={{ fontSize: tokens.fontSize.sm }}>
              {f.touches.map((t) => (
                <div key={t.id} style={{ borderBottom: `1px solid ${tokens.color.border}`, padding: `${tokens.space.xs}px 0` }}>
                  <strong>{TOUCH_LABEL[t.kind] ?? t.kind}</strong>
                  {t.channel ? ` · ${words(t.channel)}` : ""} · {new Date(t.occurred_at).toLocaleString()}
                  {t.source === "outreach" && <span style={{ color: tokens.color.inkSubtle }}> · from Outreach</span>}
                  {t.note && <div style={{ color: tokens.color.inkMuted, whiteSpace: "pre-wrap" }}>{t.note}</div>}
                </div>
              ))}
            </div>
            {f.outreach.primary && (
              <div style={{ fontSize: tokens.fontSize.sm, whiteSpace: "pre-wrap", color: tokens.color.inkMuted }}>
                <strong>Original suggested outreach:</strong> {f.outreach.primary}
              </div>
            )}
            <SubjectContacts subjectType="intel_candidate" subjectId={f.id} />
          </div>
        </details>
      </div>
    </Card>
  );
}

function Group({ title, subtitle, items, onChange }: { title: string; subtitle: string; items: FollowUpItem[]; onChange: () => void }) {
  if (!items.length) return null;
  return (
    <section className="oos-stack" style={{ gap: tokens.space.md }}>
      <div>
        <h2 style={{ margin: 0, fontSize: tokens.fontSize.lg, color: tokens.color.ink }}>
          {title} <span style={{ color: tokens.color.inkSubtle, fontWeight: 400 }}>({items.length})</span>
        </h2>
        <div style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>{subtitle}</div>
      </div>
      {items.map((f) => (
        <FollowUpCard key={f.id} f={f} onChange={onChange} />
      ))}
    </section>
  );
}

const CLOSED_TONE: Record<ClosedCandidate["user_status"], Tone> = { won: "success", lost: "danger", dismissed: "neutral" };

function Closed() {
  const [status, setStatus] = useState<ClosedCandidate["user_status"] | undefined>(undefined);
  const closed = useAsync(() => api.closedCandidates(status), [status]);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="oos-stack" style={{ gap: tokens.space.md }}>
      <div style={{ display: "flex", gap: tokens.space.xs }} role="group" aria-label="Filter">
        {([undefined, "won", "lost", "dismissed"] as const).map((s) => (
          <Button key={s ?? "all"} size="sm" variant={s === status ? "primary" : "secondary"} aria-pressed={s === status} onClick={() => setStatus(s)}>
            {s ? words(s) : "All"}
          </Button>
        ))}
      </div>
      <AsyncView state={closed} loadingLabel="Loading the archive">
        {({ items }) =>
          items.length === 0 ? (
            <Card>
              <EmptyState compact title="Nothing closed yet" description="Won, lost and dismissed candidates are kept here with their reasons." />
            </Card>
          ) : (
            <Card flush>
              {items.map((c) => (
                <div key={c.id} style={{ display: "flex", gap: tokens.space.md, alignItems: "baseline", flexWrap: "wrap", padding: `${tokens.space.sm}px ${tokens.space.md}px`, borderBottom: `1px solid ${tokens.color.border}`, fontSize: tokens.fontSize.sm }}>
                  <Badge tone={CLOSED_TONE[c.user_status]}>{c.user_status}</Badge>
                  <a href={c.lead_url} target="_blank" rel="noopener noreferrer" className="oos-link" style={{ fontWeight: 600 }}>
                    {c.title}
                  </a>
                  {c.outcome_reason && <span style={{ color: tokens.color.inkMuted }}>{words(c.outcome_reason)}</span>}
                  {c.realized_usd ? <span>{usd(c.realized_usd)}</span> : null}
                  <span style={{ color: tokens.color.inkSubtle }}>
                    closed {ago(c.closed_at)} · {c.outbound_touches} {c.outbound_touches === 1 ? "touch" : "touches"}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === c.id}
                    onClick={() => {
                      setBusy(c.id);
                      api
                        .setIntelStatus(c.id, { status: "open" })
                        .then(closed.reload)
                        .finally(() => setBusy(null));
                    }}
                  >
                    Reopen
                  </Button>
                  {c.outcome_note && <div style={{ flexBasis: "100%", color: tokens.color.inkMuted }}>{c.outcome_note}</div>}
                </div>
              ))}
            </Card>
          )
        }
      </AsyncView>
    </div>
  );
}

export default function FollowUpsPage() {
  const [tab, setTab] = useState<"working" | "closed">("working");
  const data = useAsync(() => api.followUps(), []);
  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <PageHeader
        eyebrow="Opportunity intelligence"
        title="Follow-ups"
        subtitle="Candidates you have contacted, aged on a follow-up schedule. Listings get follow-ups on days 1, 3 and 6; business offers on days 3, 7 and 14. A response wants a next step within two days."
        actions={
          <div style={{ display: "flex", gap: tokens.space.xs }} role="tablist">
            <Button size="sm" variant={tab === "working" ? "primary" : "secondary"} aria-pressed={tab === "working"} onClick={() => setTab("working")}>
              Working
            </Button>
            <Button size="sm" variant={tab === "closed" ? "primary" : "secondary"} aria-pressed={tab === "closed"} onClick={() => setTab("closed")}>
              Closed
            </Button>
          </div>
        }
      />
      {tab === "closed" ? (
        <Closed />
      ) : (
        <AsyncView state={data} loadingLabel="Loading follow-ups">
          {({ counts, items }) => {
            const by = (s: FollowUpStage) => items.filter((i) => i.plan.stage === s);
            return (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: tokens.space.md }}>
                  <StatCard label="Due now" value={String(counts.due)} />
                  <StatCard label="Stalled" value={String(counts.stalled)} hint="responded, no movement in 14 days" />
                  <StatCard label="Gone cold" value={String(counts.cold)} hint="no reply after the last follow-up" />
                  <StatCard label="Waiting" value={String(counts.upcoming)} />
                </div>
                {items.length === 0 ? (
                  <Card>
                    <EmptyState compact title="Nothing being worked" description="Mark a candidate contacted in the Action Queue, or approve an email about it, and it moves here." />
                  </Card>
                ) : (
                  <>
                    <Group title="Due now" subtitle="Time for the next touch." items={by("due")} onChange={data.reload} />
                    <Group title="Stalled" subtitle="They responded, then nothing for two weeks." items={by("stalled")} onChange={data.reload} />
                    <Group title="Gone cold" subtitle="Every follow-up sent, no reply. Close it or snooze it." items={by("cold")} onChange={data.reload} />
                    <Group title="Waiting" subtitle="Next touch not due yet, or snoozed." items={by("upcoming")} onChange={data.reload} />
                  </>
                )}
              </>
            );
          }}
        </AsyncView>
      )}
    </div>
  );
}
