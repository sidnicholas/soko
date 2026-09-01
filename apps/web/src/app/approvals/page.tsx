"use client";

import { useState } from "react";
import type { Approval } from "@opportunity-os/contracts";
import { Badge, Button, Card, EmptyState, PageHeader, formatDateTime, tokens } from "@opportunity-os/ui";
import { api } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";

export default function ApprovalsPage() {
  const approvals = useAsync<Approval[]>(() => api.listApprovals(), []);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, decision: "approve" | "reject") {
    setBusyId(id);
    setError(null);
    try {
      await api.decideApproval(id, decision);
      approvals.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${decision} this request.`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <PageHeader
        eyebrow="Approvals"
        title="Approvals inbox"
        subtitle="Every binding action — outbound negotiation, purchases, and fund movement — is a policy-enforced human gate (§14). Review the request and its risk before deciding."
      />

      {error && (
        <div style={{ padding: tokens.space.md, borderRadius: tokens.radius.md, background: "#fdecec", color: "#b02525", fontSize: tokens.fontSize.sm }}>
          {error}
        </div>
      )}

      <AsyncView state={approvals} loadingLabel="Loading approvals">
        {(rows) =>
          rows.length === 0 ? (
            <Card>
              <EmptyState
                title="Inbox zero"
                description="No pending approvals. When an agent needs a binding decision it will surface here with a full summary and risk read-out."
              />
            </Card>
          ) : (
            <div className="oos-stack">
              {rows.map((a) => (
                <Card key={a.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: tokens.space.lg, flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", gap: tokens.space.sm, flexWrap: "wrap", marginBottom: tokens.space.sm }}>
                        <Badge status={a.status} />
                        <Badge tone="accent">{a.action_type}</Badge>
                        <Badge tone="neutral">{a.entity_type}</Badge>
                      </div>
                      <p style={{ margin: 0, fontSize: tokens.fontSize.md, color: tokens.color.ink, fontWeight: 500 }}>{a.human_readable_summary}</p>
                      {a.risk_summary && (
                        <p style={{ margin: `${tokens.space.sm}px 0 0`, fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>
                          <strong style={{ color: tokens.color.ink }}>Risk:</strong> {a.risk_summary}
                        </p>
                      )}
                      <div style={{ marginTop: tokens.space.sm, display: "flex", gap: tokens.space.lg, flexWrap: "wrap", fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>
                        <span>Requested by {a.requested_by_agent}</span>
                        <span>Expires {formatDateTime(a.expires_at)}</span>
                        <span style={{ fontFamily: tokens.font.mono }}>payload {a.payload_hash.slice(0, 12)}…</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "flex-start", flexShrink: 0 }}>
                      <Button variant="danger" loading={busyId === a.id} onClick={() => decide(a.id, "reject")}>
                        Reject
                      </Button>
                      <Button variant="primary" loading={busyId === a.id} onClick={() => decide(a.id, "approve")}>
                        Approve
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )
        }
      </AsyncView>
    </div>
  );
}
