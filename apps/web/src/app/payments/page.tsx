"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { EscrowPredicateType, type SettlementMilestone, type Evidence } from "@opportunity-os/contracts";
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
  Spinner,
  StatCard,
  Textarea,
  formatDateTime,
  formatMoney,
  statusLabel,
  tokens,
} from "@opportunity-os/ui";
import { api, ApiError, type TransactionDetail } from "../../lib/api";

function milestoneAmount(m: SettlementMilestone): string {
  return m.amount_or_percentage.kind === "percentage" ? `${m.amount_or_percentage.value}%` : formatMoney({ amount: m.amount_or_percentage.value, currency: "USD" });
}

const MILESTONE_TONE: Record<SettlementMilestone["status"], "neutral" | "info" | "success" | "danger"> = {
  pending: "neutral",
  verified: "info",
  released: "success",
  disputed: "danger",
  refunded: "danger",
};

/** Inline "reveal a reason field, then confirm" control — every dispute/freeze/refund action needs one (§20). */
function ReasonAction({ label, variant = "secondary", busy, onConfirm }: { label: string; variant?: "secondary" | "danger"; busy: boolean; onConfirm: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) {
    return (
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  return (
    <div style={{ display: "flex", gap: tokens.space.xs, alignItems: "center", flexWrap: "wrap" }}>
      <Input
        autoFocus
        placeholder="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{ width: 200 }}
      />
      <Button
        size="sm"
        variant={variant}
        loading={busy}
        disabled={!reason.trim()}
        onClick={() => {
          onConfirm(reason.trim());
          setOpen(false);
          setReason("");
        }}
      >
        Confirm {label.toLowerCase()}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  );
}

interface MilestonePanelProps {
  milestone: SettlementMilestone;
  planStatus: string;
  onChanged: () => void;
}

/**
 * Detail + actions for one selected milestone (UI-4): evidence ledger + submit,
 * release (with an optional approval-token field for above-threshold releases),
 * dispute / resolve-dispute, refund. Mirrors exactly what the API enforces —
 * this panel doesn't decide anything, it just calls the gated endpoints.
 */
function MilestonePanel({ milestone: m, planStatus, onChanged }: MilestonePanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ledger, setLedger] = useState<Evidence[] | null>(null);
  const [predicateType, setPredicateType] = useState<string>(EscrowPredicateType.options[0]);
  const [payload, setPayload] = useState("{}");
  const [releaseToken, setReleaseToken] = useState("");
  const [refundToken, setRefundToken] = useState("");

  const run = useCallback(async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${key}.`);
    } finally {
      setBusy(null);
    }
  }, [onChanged]);

  const loadLedger = useCallback(async () => {
    setBusy("ledger");
    setError(null);
    try {
      setLedger(await api.getEvidenceLedger(m.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the evidence ledger.");
    } finally {
      setBusy(null);
    }
  }, [m.id]);

  const recipients = m.recipients_json;
  const disputed = planStatus === "DISPUTED" || planStatus === "FROZEN";
  const releasable = m.status === "pending" || m.status === "verified";

  return (
    <Card title={`Milestone ${m.sequence + 1} — ${m.name}`} subtitle={`${milestoneAmount(m)} · ${statusLabel(m.status)}`}>
      <div className="oos-stack" style={{ gap: tokens.space.lg }}>
        {error && (
          <div style={{ padding: tokens.space.sm, borderRadius: tokens.radius.md, background: "#fdecec", color: "#b02525", fontSize: tokens.fontSize.sm }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: tokens.space.lg, flexWrap: "wrap", fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>
          {m.optimistic_after_at && <span>Optimistic release after {formatDateTime(m.optimistic_after_at)}</span>}
          {m.deadman_at && <span>Deadman refund after {formatDateTime(m.deadman_at)}</span>}
          {recipients.length > 0 && <span>{recipients.length} recipient split</span>}
        </div>

        {recipients.length > 0 && (
          <div className="oos-stack" style={{ gap: tokens.space.xs }}>
            {recipients.map((r, i) => (
              <div key={i} style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkMuted, fontFamily: tokens.font.mono }}>
                {r.address} — {r.amount.kind === "percentage" ? `${r.amount.value}%` : formatMoney({ amount: r.amount.value, currency: "USD" })}
                {r.externalRef ? ` (${r.externalRef})` : ""}
              </div>
            ))}
          </div>
        )}

        <div>
          <Button size="sm" onClick={loadLedger} loading={busy === "ledger"}>
            {ledger ? "Refresh evidence ledger" : "View evidence ledger"}
          </Button>
          {ledger && (
            <div style={{ marginTop: tokens.space.sm }}>
              {ledger.length === 0 ? (
                <EmptyState compact title="No evidence yet" description="Nothing has been submitted against this milestone." />
              ) : (
                <DataTable
                  rows={ledger}
                  getRowKey={(e) => e.id}
                  columns={[
                    { key: "predicate", header: "Predicate", render: (e) => e.predicate_type ?? "—" },
                    { key: "verifier", header: "Verifier", render: (e) => e.verifier ?? "—" },
                    { key: "trust", header: "Trust", render: (e) => e.trust_tier ?? "—" },
                    { key: "at", header: "Captured", align: "right", render: (e) => formatDateTime(e.captured_at) },
                    { key: "hash", header: "Hash", render: (e) => <span style={{ fontFamily: tokens.font.mono, fontSize: tokens.fontSize.xs }}>{(e.evidence_hash ?? "").slice(0, 10)}…</span> },
                  ]}
                />
              )}
            </div>
          )}
        </div>

        {(m.status === "pending" || m.status === "verified") && (
          <div className="oos-stack" style={{ gap: tokens.space.sm }}>
            <div style={{ fontSize: tokens.fontSize.sm, fontWeight: tokens.weight.medium }}>Submit evidence</div>
            <div style={{ display: "flex", gap: tokens.space.sm, flexWrap: "wrap", alignItems: "flex-end" }}>
              <Field label="Predicate">
                <Select value={predicateType} onChange={(e) => setPredicateType(e.target.value)} style={{ minWidth: 200 }}>
                  {EscrowPredicateType.options.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              </Field>
              <div style={{ flex: 1, minWidth: 220 }}>
                <Field label="Payload (JSON)">
                  <Textarea value={payload} onChange={(e) => setPayload(e.target.value)} rows={2} />
                </Field>
              </div>
              <Button
                loading={busy === "evidence"}
                onClick={() =>
                  run("evidence", async () => {
                    const parsed = JSON.parse(payload || "{}");
                    await api.submitEvidence(m.id, { predicateType, payload: parsed });
                  })
                }
              >
                Submit
              </Button>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: tokens.space.sm, flexWrap: "wrap", alignItems: "center", borderTop: `1px solid ${tokens.color.border}`, paddingTop: tokens.space.md }}>
          {releasable && !disputed && (
            <div style={{ display: "flex", gap: tokens.space.xs, alignItems: "center" }}>
              <Input placeholder="Approval token (if required)" value={releaseToken} onChange={(e) => setReleaseToken(e.target.value)} style={{ width: 220 }} />
              <Button variant="primary" loading={busy === "release"} onClick={() => run("release", () => api.releaseMilestone(m.id, releaseToken || undefined))}>
                Release
              </Button>
            </div>
          )}

          {releasable && (
            <ReasonAction label="Dispute" variant="danger" busy={busy === "dispute"} onConfirm={(reason) => run("dispute", () => api.disputeMilestone(m.id, { reason }))} />
          )}

          {m.status === "disputed" && (
            <ReasonAction label="Resolve dispute" busy={busy === "resolve"} onConfirm={(reason) => run("resolve", () => api.resolveDispute(m.id, { reason }))} />
          )}

          {m.status !== "released" && m.status !== "refunded" && (
            <div style={{ display: "flex", gap: tokens.space.xs, alignItems: "center" }}>
              <Input placeholder="Approval token (if required)" value={refundToken} onChange={(e) => setRefundToken(e.target.value)} style={{ width: 220 }} />
              <ReasonAction
                label="Refund"
                variant="danger"
                busy={busy === "refund"}
                onConfirm={(reason) => run("refund", () => api.refundMilestone(m.id, { reason }, refundToken || undefined))}
              />
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Create a milestone with a single-predicate release condition — a full AND/OR tree builder is out of scope for V1's UI (§escrow supports it; this form covers the common case). */
function CreateMilestoneForm({ planId, nextSequence, onCreated }: { planId: string; nextSequence: number; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"amount" | "percentage">("percentage");
  const [value, setValue] = useState("100");
  const [predicateType, setPredicateType] = useState<string>(EscrowPredicateType.options[0]);
  const [optimisticAfterAt, setOptimisticAfterAt] = useState("");
  const [deadmanAt, setDeadmanAt] = useState("");

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        + Add milestone
      </Button>
    );
  }

  return (
    <Card title="New milestone">
      <div className="oos-stack" style={{ gap: tokens.space.md }}>
        {error && (
          <div style={{ padding: tokens.space.sm, borderRadius: tokens.radius.md, background: "#fdecec", color: "#b02525", fontSize: tokens.fontSize.sm }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: tokens.space.md, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <Field label="Name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. delivery confirmed" />
            </Field>
          </div>
          <Field label="Amount kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as "amount" | "percentage")}>
              <option value="percentage">% of plan total</option>
              <option value="amount">Fixed amount (minor units)</option>
            </Select>
          </Field>
          <Field label="Value">
            <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 120 }} />
          </Field>
        </div>
        <div style={{ display: "flex", gap: tokens.space.md, flexWrap: "wrap" }}>
          <Field label="Release condition predicate" hint="A single predicate; combine more via the API for AND/OR trees.">
            <Select value={predicateType} onChange={(e) => setPredicateType(e.target.value)} style={{ minWidth: 220 }}>
              {EscrowPredicateType.options.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Optimistic release after" hint="Optional — release even without full evidence past this instant (ST-13).">
            <Input type="datetime-local" value={optimisticAfterAt} onChange={(e) => setOptimisticAfterAt(e.target.value)} />
          </Field>
          <Field label="Deadman refund after" hint="Optional — auto-refund if conditions are still unmet past this instant.">
            <Input type="datetime-local" value={deadmanAt} onChange={(e) => setDeadmanAt(e.target.value)} />
          </Field>
        </div>
        <div style={{ display: "flex", gap: tokens.space.sm }}>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim() || !value.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.createMilestone(planId, {
                  sequence: nextSequence,
                  name: name.trim(),
                  amount: { kind, value: Number(value) },
                  releaseConditions: { predicate: { type: predicateType } },
                  ...(optimisticAfterAt ? { optimisticAfterAt: new Date(optimisticAfterAt).toISOString() } : {}),
                  ...(deadmanAt ? { deadmanAt: new Date(deadmanAt).toISOString() } : {}),
                });
                setOpen(false);
                setName("");
                onCreated();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Could not create the milestone.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Create
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PaymentsView() {
  const params = useSearchParams();
  const initial = params?.get("tx") ?? "";
  const [txId, setTxId] = useState(initial);
  const [query, setQuery] = useState(initial);
  const [data, setData] = useState<TransactionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedMilestoneId, setSelectedMilestoneId] = useState<string | null>(null);
  const [planBusy, setPlanBusy] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    if (!id.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setData(await api.getTransaction(id.trim()));
    } catch (err) {
      setData(null);
      setError(err instanceof ApiError ? err.message : "Could not load settlement.");
    } finally {
      setLoading(false);
    }
  }, []);

  const reload = useCallback(() => {
    if (txId) void load(txId);
  }, [txId, load]);

  useEffect(() => {
    if (initial) void load(initial);
  }, [initial, load]);

  const released = data?.milestones.filter((m) => m.status === "released").length ?? 0;
  const total = data?.milestones.length ?? 0;
  const plan = data?.settlement_plan ?? null;
  const selected = data?.milestones.find((m) => m.id === selectedMilestoneId) ?? null;

  async function planAction(key: string, fn: () => Promise<unknown>) {
    setPlanBusy(key);
    setError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${key}.`);
    } finally {
      setPlanBusy(null);
    }
  }

  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <PageHeader
        eyebrow="Payments"
        title="Settlement"
        subtitle="Track a transaction's settlement plan and milestone releases across the progressive state machine (§20). Every release is policy-gated and audited."
      />

      <Card title="Load a transaction" subtitle="Settlement is scoped to a transaction in V1.">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setTxId(query);
            void load(query);
          }}
          style={{ display: "flex", gap: tokens.space.sm, alignItems: "flex-end", flexWrap: "wrap" }}
        >
          <div style={{ flex: 1, minWidth: 260 }}>
            <Field label="Transaction ID" htmlFor="tx">
              <Input id="tx" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. 8f14e45f-ceea-4f43-9c2b-000000000000" />
            </Field>
          </div>
          <Button type="submit" variant="primary" loading={loading}>
            Load
          </Button>
        </form>
      </Card>

      {loading && (
        <Card>
          <div style={{ display: "flex", justifyContent: "center", padding: tokens.space.xl }}>
            <Spinner label="Loading settlement" />
          </div>
        </Card>
      )}

      {error && !loading && (
        <div style={{ padding: tokens.space.md, borderRadius: tokens.radius.md, background: "#fdecec", color: "#b02525", fontSize: tokens.fontSize.sm }}>
          {error}
        </div>
      )}

      {!loading && !data && !error && (
        <Card>
          <EmptyState
            title="No transaction loaded"
            description="Enter a transaction ID above to inspect its settlement plan and milestones. Open a transaction from the Payments or Approvals flow to get its ID."
          />
        </Card>
      )}

      {data && !loading && (
        <>
          <div style={{ display: "flex", gap: tokens.space.md, alignItems: "center", flexWrap: "wrap" }}>
            <Badge status={data.status} />
            <Link href={`/transactions/${data.id}`} className="oos-link">
              View transaction {data.id.slice(0, 8)} →
            </Link>
          </div>

          {plan ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: tokens.space.md }}>
                <StatCard label="Plan total" value={formatMoney(plan.total_amount)} tone="info" />
                <StatCard label="Settlement status" value={statusLabel(plan.status)} tone="progress" />
                <StatCard label="Rail" value={statusLabel(plan.rail_family)} hint={`${plan.provider} · ${plan.asset}`} />
                <StatCard label="Milestones released" value={`${released}/${total}`} tone={released === total && total > 0 ? "success" : "warning"} />
              </div>

              <div style={{ display: "flex", gap: tokens.space.sm, flexWrap: "wrap" }}>
                {plan.status === "DRAFT" && (
                  <Button variant="primary" loading={planBusy === "fund"} onClick={() => planAction("fund", () => api.fundSettlementPlan(plan.id))}>
                    Fund plan
                  </Button>
                )}
                {plan.status === "FROZEN" ? (
                  <ReasonAction label="Unfreeze" busy={planBusy === "unfreeze"} onConfirm={(reason) => planAction("unfreeze", () => api.unfreezeSettlementPlan(plan.id, { reason }))} />
                ) : (
                  plan.status !== "SETTLED" &&
                  plan.status !== "REFUNDED" && (
                    <ReasonAction label="Freeze plan" variant="danger" busy={planBusy === "freeze"} onConfirm={(reason) => planAction("freeze", () => api.freezeSettlementPlan(plan.id, { reason }))} />
                  )
                )}
              </div>

              <Card
                title="Milestones"
                subtitle={`Release policy: ${statusLabel(plan.human_release_policy)}.`}
                flush
                actions={<CreateMilestoneForm planId={plan.id} nextSequence={total} onCreated={reload} />}
              >
                <DataTable
                  rows={data.milestones}
                  getRowKey={(m) => m.id}
                  empty={<EmptyState compact title="No milestones" description="This settlement plan has no milestones defined yet." />}
                  columns={[
                    { key: "seq", header: "#", width: 44, render: (m) => <span style={{ color: tokens.color.inkSubtle }}>{m.sequence}</span> },
                    { key: "name", header: "Milestone", render: (m) => <span style={{ fontWeight: 500 }}>{m.name}</span> },
                    { key: "amount", header: "Amount", align: "right", render: (m) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{milestoneAmount(m)}</span> },
                    { key: "status", header: "Status", render: (m) => <Badge tone={MILESTONE_TONE[m.status]}>{statusLabel(m.status)}</Badge>, width: 130 },
                    { key: "approved", header: "Approved", align: "right", render: (m) => formatDateTime(m.approved_at) },
                    { key: "released", header: "Released", align: "right", render: (m) => formatDateTime(m.released_at) },
                    {
                      key: "manage",
                      header: "",
                      width: 100,
                      render: (m) => (
                        <Button size="sm" variant={selectedMilestoneId === m.id ? "primary" : "secondary"} onClick={() => setSelectedMilestoneId(m.id === selectedMilestoneId ? null : m.id)}>
                          Manage
                        </Button>
                      ),
                    },
                  ]}
                />
              </Card>

              {selected && <MilestonePanel milestone={selected} planStatus={plan.status} onChanged={reload} />}
            </>
          ) : (
            <Card>
              <EmptyState
                title="No settlement plan yet"
                description="This transaction has no settlement plan. A plan is created when the transaction reaches the funding stage of the settlement workflow (§11.3)."
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

export default function PaymentsPage() {
  return (
    <Suspense fallback={<Spinner label="Loading" />}>
      <PaymentsView />
    </Suspense>
  );
}
