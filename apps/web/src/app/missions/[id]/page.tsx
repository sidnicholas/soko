"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { AutonomyPolicy, DemandSpecification, Money, Urgency } from "@opportunity-os/contracts";
import type { Opportunity } from "@opportunity-os/contracts";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  Timeline,
  formatDateTime,
  formatMoney,
  formatScore,
  statusLabel,
  tokens,
  type TimelineItem,
} from "@opportunity-os/ui";
import { api, type MissionDetail } from "../../../lib/api";
import { useAsync } from "../../../lib/useAsync";
import { AsyncView } from "../../../components/AsyncView";
import { scoreTone } from "../../../lib/opportunity";

const URGENCIES: Urgency[] = ["immediate", "today", "days", "scheduled", "flexible"];
const POLICY_LABEL: Record<AutonomyPolicy, string> = {
  discover_only: "Discover only",
  prepare_negotiation: "Prepare negotiation",
  full_prepare: "Full prepare",
};
const STATUS_NARRATIVE: Record<string, string> = {
  active: "Active — continuously discovering, scoring, and refreshing opportunities.",
  paused: "Paused — no new discovery runs until you resume.",
  archived: "Archived — discovery stopped and the mission is read-only.",
  draft: "Draft — not yet dispatched to the discovery pipeline.",
  completed: "Completed — this mission has met its goal.",
};

function centsToDollars(money: Money | null | undefined): string {
  return money ? String(money.amount / 100) : "";
}

function dollarsToMoney(value: string): Money | undefined {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return { amount: Math.round(n * 100), currency: "USD" };
}

function buildTimeline(m: MissionDetail): TimelineItem[] {
  const items: TimelineItem[] = [
    { id: "created", title: "Mission created", at: formatDateTime(m.created_at), tone: "info", description: m.raw_intent },
  ];
  if (m.current_version_number !== null) {
    items.push({
      id: "version",
      title: `Constraints snapshot v${m.current_version_number}`,
      at: formatDateTime(m.updated_at),
      tone: "progress",
      description: "Immutable demand specification recorded for this version.",
    });
  }
  if (m.status === "active") items.push({ id: "active", title: "Discovery active", at: formatDateTime(m.updated_at), tone: "success" });
  if (m.status === "paused") items.push({ id: "paused", title: "Discovery paused", at: formatDateTime(m.updated_at), tone: "warning" });
  if (m.archived_at) items.push({ id: "archived", title: "Mission archived", at: formatDateTime(m.archived_at), tone: "neutral" });
  return items;
}

export default function MissionDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const mission = useAsync<MissionDetail>(() => api.getMission(params.id), [params.id]);
  const opportunities = useAsync<Opportunity[]>(() => api.listMissionOpportunities(params.id), [params.id]);
  const [busy, setBusy] = useState<null | string>(null);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function control(action: "pause" | "resume" | "archive") {
    setBusy(action);
    setNotice(null);
    try {
      if (action === "pause") await api.pauseMission(params.id);
      else if (action === "resume") await api.resumeMission(params.id);
      else await api.archiveMission(params.id);
      mission.reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : `Could not ${action} mission.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <AsyncView state={mission} loadingLabel="Loading mission">
        {(m) => {
          const spec = m.demand_spec;
          return (
            <>
              <PageHeader
                eyebrow={<Link href="/archive" className="oos-link">Missions</Link>}
                title={m.title}
                subtitle={m.raw_intent}
                actions={
                  <>
                    {m.status === "active" && (
                      <Button variant="secondary" loading={busy === "pause"} onClick={() => control("pause")}>
                        Pause
                      </Button>
                    )}
                    {m.status === "paused" && (
                      <Button variant="secondary" loading={busy === "resume"} onClick={() => control("resume")}>
                        Resume
                      </Button>
                    )}
                    {m.status !== "archived" && (
                      <Button variant="danger" loading={busy === "archive"} onClick={() => control("archive")}>
                        Archive
                      </Button>
                    )}
                  </>
                }
              />

              <div style={{ display: "flex", gap: tokens.space.md, alignItems: "center", flexWrap: "wrap" }}>
                <Badge status={m.status} />
                <Badge tone="accent">{POLICY_LABEL[m.agent_autonomy_policy]}</Badge>
                {m.current_version_number !== null && <Badge tone="neutral">Constraints v{m.current_version_number}</Badge>}
              </div>

              {notice && (
                <div style={{ padding: tokens.space.md, borderRadius: tokens.radius.md, background: "#fdecec", color: "#b02525", fontSize: tokens.fontSize.sm }}>
                  {notice}
                </div>
              )}

              <Card title="Agent status">
                <p style={{ margin: 0, color: tokens.color.inkMuted }}>{STATUS_NARRATIVE[m.status] ?? statusLabel(m.status)}</p>
                <p style={{ margin: `${tokens.space.sm}px 0 0`, fontSize: tokens.fontSize.sm, color: tokens.color.inkSubtle }}>
                  Autonomy ceiling: {POLICY_LABEL[m.agent_autonomy_policy]}. Outbound negotiation is always human-gated in V1 (§14).
                </p>
              </Card>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: tokens.space.lg, alignItems: "start" }}>
                {editing ? (
                  <ConstraintEditor
                    mission={m}
                    onCancel={() => setEditing(false)}
                    onSaved={() => {
                      setEditing(false);
                      mission.reload();
                    }}
                  />
                ) : (
                  <Card
                    title="Current request"
                    subtitle="The active demand specification."
                    actions={
                      m.status !== "archived" ? (
                        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                          Edit constraints
                        </Button>
                      ) : undefined
                    }
                  >
                    {spec ? (
                      <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: tokens.space.md, margin: 0 }}>
                        {[
                          ["What", spec.what.description],
                          ["Target budget", formatMoney(spec.budget.target)],
                          ["Maximum budget", formatMoney(spec.budget.maximum)],
                          ["Budget flexible", spec.budget.flexible ? "Yes" : "No"],
                          ["Urgency", spec.timing.urgency],
                          ["Fulfillment", spec.fulfillment.type],
                          ["Payment", spec.payment.acceptableMethods.join(", ") || "—"],
                          ["Substitutes", spec.flexibility.substitutesAllowed ? "Allowed" : "Not allowed"],
                        ].map(([k, v]) => (
                          <div key={k}>
                            <dt style={{ fontSize: tokens.fontSize.xs, textTransform: "uppercase", letterSpacing: "0.04em", color: tokens.color.inkSubtle }}>{k}</dt>
                            <dd style={{ margin: `${tokens.space.xs}px 0 0`, fontSize: tokens.fontSize.sm, color: tokens.color.ink }}>{v}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <EmptyState compact title="No specification recorded" description="This mission has no parsed demand specification yet." />
                    )}
                  </Card>
                )}

                <Card title="Sharing" subtitle="Future-ready collaboration (§15.4).">
                  <p style={{ margin: 0, color: tokens.color.inkMuted, fontSize: tokens.fontSize.sm }}>
                    Missions are owner-scoped in V1. The data model and API already support shared missions, collaborators, and comments — the
                    sharing surface will light up here without a schema change.
                  </p>
                  <div style={{ marginTop: tokens.space.md }}>
                    <Button size="sm" variant="secondary" disabled title="Sharing arrives in a later release">
                      Share mission
                    </Button>
                  </div>
                </Card>
              </div>

              <Card title="Opportunities found" subtitle="Matches scored for this mission, highest first." flush>
                <AsyncView state={opportunities} loadingLabel="Loading opportunities">
                  {(rows) =>
                    rows.length === 0 ? (
                      <EmptyState
                        compact
                        title="No opportunities yet"
                        description="The discovery pipeline is still working, or no supply has matched these constraints. Refine the constraints to widen the search."
                      />
                    ) : (
                      <DataTable
                        rows={rows}
                        getRowKey={(o) => o.id}
                        onRowClick={(o) => router.push(`/opportunities/${o.id}`)}
                        columns={[
                          {
                            key: "action",
                            header: "Opportunity",
                            render: (o) => (
                              <Link href={`/opportunities/${o.id}`} className="oos-link">
                                {o.next_action ?? `Opportunity ${o.id.slice(0, 8)}`}
                              </Link>
                            ),
                          },
                          { key: "status", header: "Status", render: (o) => <Badge status={o.status} />, width: 150 },
                          { key: "score", header: "Score", align: "right", render: (o) => <Badge tone={scoreTone(o.overall_score)}>{formatScore(o.overall_score)}</Badge> },
                          { key: "profit", header: "Net profit", align: "right", render: (o) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatMoney(o.expected_net_profit)}</span> },
                        ]}
                      />
                    )
                  }
                </AsyncView>
              </Card>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: tokens.space.lg, alignItems: "start" }}>
                <Card title="Rejected alternatives" subtitle="Why candidates were set aside.">
                  <EmptyState
                    compact
                    title="No rejected alternatives"
                    description="Discarded matches with their concise rejection reason will appear here once the scoring engine records them for this mission."
                  />
                </Card>

                <Card title="Agent questions" subtitle="Where the agent needs your input.">
                  <EmptyState
                    compact
                    title="No open questions"
                    description="When an agent needs a decision to proceed, it will ask here instead of guessing."
                  />
                </Card>
              </div>

              <Card title="Activity">
                <Timeline items={buildTimeline(m)} />
              </Card>
            </>
          );
        }}
      </AsyncView>
    </div>
  );
}

function ConstraintEditor({ mission, onCancel, onSaved }: { mission: MissionDetail; onCancel: () => void; onSaved: () => void }) {
  const spec = mission.demand_spec;
  const [description, setDescription] = useState(spec?.what.description ?? mission.raw_intent);
  const [target, setTarget] = useState(centsToDollars(spec?.budget.target));
  const [maximum, setMaximum] = useState(centsToDollars(spec?.budget.maximum));
  const [flexible, setFlexible] = useState(spec?.budget.flexible ?? true);
  const [urgency, setUrgency] = useState<Urgency>(spec?.timing.urgency ?? "days");
  const [substitutes, setSubstitutes] = useState(spec?.flexibility.substitutesAllowed ?? true);
  const [policy, setPolicy] = useState<AutonomyPolicy>(mission.agent_autonomy_policy);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    if (description.trim().length === 0) {
      setError("Describe what you need.");
      return;
    }
    const base: DemandSpecification = spec ?? {
      what: { description: description.trim() },
      budget: { flexible },
      quality: { constraints: [] },
      timing: { urgency },
      payment: { acceptableMethods: ["card"] },
      fulfillment: { type: "ship" },
      flexibility: { substitutesAllowed: substitutes, negotiableFields: [], nonNegotiables: [] },
      negotiationAuthorization: { mayPrepare: policy !== "discover_only", maySend: false },
    };
    const demand_spec: DemandSpecification = {
      ...base,
      what: { ...base.what, description: description.trim() },
      budget: { ...base.budget, target: dollarsToMoney(target), maximum: dollarsToMoney(maximum), flexible },
      quality: { ...base.quality, naturalLanguage: description.trim() },
      timing: { ...base.timing, urgency },
      flexibility: { ...base.flexibility, substitutesAllowed: substitutes },
      negotiationAuthorization: { ...base.negotiationAuthorization, mayPrepare: policy !== "discover_only" },
    };
    setSaving(true);
    try {
      await api.updateMission(mission.id, { raw_intent: description.trim(), agent_autonomy_policy: policy, demand_spec });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save constraints.");
      setSaving(false);
    }
  }

  return (
    <Card title="Edit constraints" subtitle="Saving records a new immutable version (§6.3).">
      <div className="oos-stack" style={{ gap: tokens.space.md }}>
        <Field label="What do you need?" htmlFor="edit-desc" required>
          <Textarea id="edit-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: tokens.space.md }}>
          <Field label="Target (USD)" htmlFor="edit-target">
            <Input id="edit-target" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
          </Field>
          <Field label="Maximum (USD)" htmlFor="edit-max">
            <Input id="edit-max" inputMode="decimal" value={maximum} onChange={(e) => setMaximum(e.target.value)} />
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: tokens.space.md }}>
          <Field label="Urgency" htmlFor="edit-urgency">
            <Select id="edit-urgency" value={urgency} onChange={(e) => setUrgency(e.target.value as Urgency)}>
              {URGENCIES.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Autonomy" htmlFor="edit-policy">
            <Select id="edit-policy" value={policy} onChange={(e) => setPolicy(e.target.value as AutonomyPolicy)}>
              {(Object.keys(POLICY_LABEL) as AutonomyPolicy[]).map((p) => (
                <option key={p} value={p}>
                  {POLICY_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div style={{ display: "flex", gap: tokens.space.lg, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: tokens.space.sm, fontSize: tokens.fontSize.sm }}>
            <input type="checkbox" checked={flexible} onChange={(e) => setFlexible(e.target.checked)} /> Budget flexible
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: tokens.space.sm, fontSize: tokens.fontSize.sm }}>
            <input type="checkbox" checked={substitutes} onChange={(e) => setSubstitutes(e.target.checked)} /> Substitutes allowed
          </label>
        </div>
        {error && <div style={{ color: "#b02525", fontSize: tokens.fontSize.sm }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: tokens.space.sm }}>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving}>
            Save constraints
          </Button>
        </div>
      </div>
    </Card>
  );
}
