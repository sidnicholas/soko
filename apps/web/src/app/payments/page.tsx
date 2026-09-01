"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { SettlementMilestone } from "@opportunity-os/contracts";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Spinner,
  StatCard,
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
};

function PaymentsView() {
  const params = useSearchParams();
  const initial = params?.get("tx") ?? "";
  const [txId, setTxId] = useState(initial);
  const [query, setQuery] = useState(initial);
  const [data, setData] = useState<TransactionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (initial) void load(initial);
  }, [initial, load]);

  const released = data?.milestones.filter((m) => m.status === "released").length ?? 0;
  const total = data?.milestones.length ?? 0;

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
        <Card>
          <EmptyState title="Couldn't load settlement" description={error} />
        </Card>
      )}

      {!loading && !error && !data && (
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

          {data.settlement_plan ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: tokens.space.md }}>
                <StatCard label="Plan total" value={formatMoney(data.settlement_plan.total_amount)} tone="info" />
                <StatCard label="Settlement status" value={statusLabel(data.settlement_plan.status)} tone="progress" />
                <StatCard label="Rail" value={statusLabel(data.settlement_plan.rail_family)} hint={`${data.settlement_plan.provider} · ${data.settlement_plan.asset}`} />
                <StatCard label="Milestones released" value={`${released}/${total}`} tone={released === total && total > 0 ? "success" : "warning"} />
              </div>

              <Card title="Milestones" subtitle={`Release policy: ${statusLabel(data.settlement_plan.human_release_policy)}.`} flush>
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
                  ]}
                />
              </Card>
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
