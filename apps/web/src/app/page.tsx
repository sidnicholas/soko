"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { AutonomyPolicy, DemandSpecification, Money, PaymentMethodFamily, Urgency } from "@opportunity-os/contracts";
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
  formatDateTime,
  tokens,
} from "@opportunity-os/ui";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { AsyncView } from "../components/AsyncView";

const URGENCIES: Urgency[] = ["immediate", "today", "days", "scheduled", "flexible"];
const FULFILLMENT: DemandSpecification["fulfillment"]["type"][] = ["ship", "pickup", "onsite", "digital", "other"];
const PAYMENT_METHODS: PaymentMethodFamily[] = ["card", "ach", "wire", "stablecoin", "onchain", "cash"];
const POLICIES: { value: AutonomyPolicy; label: string; hint: string }[] = [
  { value: "discover_only", label: "Discover only", hint: "Find and score opportunities. No negotiation drafting." },
  { value: "prepare_negotiation", label: "Prepare negotiation", hint: "Draft negotiations for your review. Never sends." },
  { value: "full_prepare", label: "Full prepare", hint: "Prepare everything short of outbound send (always human-gated)." },
];

function dollarsToMoney(value: string): Money | undefined {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return { amount: Math.round(n * 100), currency: "USD" };
}

export default function SearchHomePage() {
  const router = useRouter();
  const missions = useAsync(() => api.listMissions(), []);

  const [title, setTitle] = useState("");
  const [rawIntent, setRawIntent] = useState("");
  const [target, setTarget] = useState("");
  const [maximum, setMaximum] = useState("");
  const [flexible, setFlexible] = useState(true);
  const [urgency, setUrgency] = useState<Urgency>("days");
  const [fulfillment, setFulfillment] = useState<DemandSpecification["fulfillment"]["type"]>("ship");
  const [methods, setMethods] = useState<PaymentMethodFamily[]>(["card"]);
  const [substitutes, setSubstitutes] = useState(true);
  const [policy, setPolicy] = useState<AutonomyPolicy>("discover_only");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleMethod = (m: PaymentMethodFamily) =>
    setMethods((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (rawIntent.trim().length === 0) {
      setError("Describe what you need before creating a mission.");
      return;
    }
    const demand_spec: DemandSpecification = {
      what: { description: rawIntent.trim() },
      budget: {
        target: dollarsToMoney(target),
        maximum: dollarsToMoney(maximum),
        flexible,
      },
      quality: { naturalLanguage: rawIntent.trim(), constraints: [] },
      timing: { urgency },
      payment: { acceptableMethods: methods.length > 0 ? methods : ["card"] },
      fulfillment: { type: fulfillment },
      flexibility: { substitutesAllowed: substitutes, negotiableFields: [], nonNegotiables: [] },
      negotiationAuthorization: { mayPrepare: policy !== "discover_only", maySend: false },
    };
    setSubmitting(true);
    try {
      const mission = await api.createMission({
        title: title.trim() || rawIntent.trim().slice(0, 60),
        raw_intent: rawIntent.trim(),
        agent_autonomy_policy: policy,
        demand_spec,
      });
      router.push(`/missions/${mission.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create mission.");
      setSubmitting(false);
    }
  }

  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <PageHeader
        eyebrow="Search / Ask"
        title="What do you need?"
        subtitle="Describe an outcome in plain language. Opportunity OS turns it into a persistent mission, then continuously discovers, scores, and surfaces real opportunities for your review."
      />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: tokens.space.lg, alignItems: "start" }}>
        <Card title="New mission" subtitle="Everything below becomes a structured demand specification.">
          <form onSubmit={onSubmit} className="oos-stack" style={{ gap: tokens.space.lg }}>
            <Field label="What do you need?" htmlFor="raw_intent" required hint="Plain language — the parser extracts constraints, budget signals, and timing.">
              <Textarea
                id="raw_intent"
                value={rawIntent}
                onChange={(e) => setRawIntent(e.target.value)}
                placeholder="e.g. Source 200 refurbished 27-inch monitors, delivered to Detroit within two weeks, under $120 each."
              />
            </Field>

            <Field label="Mission title" htmlFor="title" hint="Optional — defaults to a summary of your request.">
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bulk monitor sourcing" />
            </Field>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: tokens.space.md }}>
              <Field label="Target price (USD)" htmlFor="target" hint="Per-unit or total — your call.">
                <Input id="target" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="120.00" />
              </Field>
              <Field label="Maximum budget (USD)" htmlFor="maximum">
                <Input id="maximum" inputMode="decimal" value={maximum} onChange={(e) => setMaximum(e.target.value)} placeholder="24000.00" />
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: tokens.space.md }}>
              <Field label="Urgency" htmlFor="urgency">
                <Select id="urgency" value={urgency} onChange={(e) => setUrgency(e.target.value as Urgency)}>
                  {URGENCIES.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Fulfillment" htmlFor="fulfillment">
                <Select id="fulfillment" value={fulfillment} onChange={(e) => setFulfillment(e.target.value as DemandSpecification["fulfillment"]["type"])}>
                  {FULFILLMENT.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Acceptable payment methods" hint="At least one. Defaults to card.">
              <div style={{ display: "flex", flexWrap: "wrap", gap: tokens.space.sm }}>
                {PAYMENT_METHODS.map((m) => {
                  const on = methods.includes(m);
                  return (
                    <button
                      type="button"
                      key={m}
                      onClick={() => toggleMethod(m)}
                      aria-pressed={on}
                      style={{
                        cursor: "pointer",
                        padding: `4px ${tokens.space.md}px`,
                        borderRadius: tokens.radius.pill,
                        border: `1px solid ${on ? tokens.color.accent : tokens.color.borderStrong}`,
                        background: on ? tokens.color.accentSoft : tokens.color.surface,
                        color: on ? tokens.color.accent : tokens.color.inkMuted,
                        fontSize: tokens.fontSize.sm,
                        fontWeight: 500,
                      }}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Agent autonomy" htmlFor="policy" hint={POLICIES.find((p) => p.value === policy)?.hint}>
              <Select id="policy" value={policy} onChange={(e) => setPolicy(e.target.value as AutonomyPolicy)}>
                {POLICIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>

            <div style={{ display: "flex", gap: tokens.space.lg, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: tokens.space.sm, fontSize: tokens.fontSize.sm, color: tokens.color.ink }}>
                <input type="checkbox" checked={flexible} onChange={(e) => setFlexible(e.target.checked)} /> Budget is flexible
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: tokens.space.sm, fontSize: tokens.fontSize.sm, color: tokens.color.ink }}>
                <input type="checkbox" checked={substitutes} onChange={(e) => setSubstitutes(e.target.checked)} /> Substitutes allowed
              </label>
            </div>

            {error && (
              <div style={{ padding: tokens.space.md, borderRadius: tokens.radius.md, background: "#fdecec", color: "#b02525", fontSize: tokens.fontSize.sm }}>
                {error}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: tokens.space.sm }}>
              <Button type="submit" variant="primary" loading={submitting}>
                Create mission
              </Button>
            </div>
          </form>
        </Card>

        <Card title="Recent missions" subtitle="Your persistent searches." flush>
          <AsyncView state={missions} loadingLabel="Loading missions">
            {(rows) =>
              rows.length === 0 ? (
                <EmptyState
                  compact
                  title="No missions yet"
                  description="Create your first mission with the form. It stays active and refreshes opportunities on its own."
                />
              ) : (
                <DataTable
                  rows={rows}
                  getRowKey={(m) => m.id}
                  onRowClick={(m) => router.push(`/missions/${m.id}`)}
                  columns={[
                    {
                      key: "title",
                      header: "Mission",
                      render: (m) => (
                        <div style={{ display: "flex", flexDirection: "column" }}>
                          <Link href={`/missions/${m.id}`} className="oos-link">
                            {m.title}
                          </Link>
                          <span style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}>{formatDateTime(m.created_at)}</span>
                        </div>
                      ),
                    },
                    { key: "status", header: "Status", render: (m) => <Badge status={m.status} />, width: 130 },
                  ]}
                />
              )
            }
          </AsyncView>
        </Card>
      </div>
    </div>
  );
}
