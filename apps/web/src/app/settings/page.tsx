"use client";

import { Badge, Card, EmptyState, PageHeader, statusLabel, tokens } from "@opportunity-os/ui";
import { API_BASE, DEV_USER_ID, DEV_USER_ROLE } from "../../lib/api";

const HUMAN_GATED = ["Outbound negotiation", "Binding commitments", "Purchases", "Movement of funds"];
const SECURITY_POSTURE: { title: string; detail: string }[] = [
  { title: "Application-owned authorization", detail: "RBAC plus attribute/policy checks layered over the identity provider (§22)." },
  { title: "Policy-enforced approvals", detail: "Agents may request an approval but can never approve it. Settlement requires an approved command with a matching payload hash (§14)." },
  { title: "Row Level Security", detail: "User-facing tables enforce Postgres RLS so you only ever see your own missions and transactions (§22)." },
  { title: "Immutable audit trail", detail: "Every consequential action is appended to a hash-chained audit log for tamper evidence (§21)." },
];

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: tokens.space.md, padding: `${tokens.space.sm}px 0`, borderBottom: `1px solid ${tokens.color.border}` }}>
      <span style={{ color: tokens.color.inkMuted, fontSize: tokens.fontSize.sm }}>{label}</span>
      <span style={{ color: tokens.color.ink, fontSize: tokens.fontSize.sm, fontFamily: mono ? tokens.font.mono : undefined, wordBreak: "break-all", textAlign: "right" }}>{value}</span>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <PageHeader eyebrow="Settings" title="Account & security" subtitle="Your operator identity and the safety guarantees enforced across the platform." />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: tokens.space.lg, alignItems: "start" }}>
        <Card title="Account" subtitle="Identity used for API requests.">
          <Row label="User ID" value={DEV_USER_ID} mono />
          <Row label="Role" value={statusLabel(DEV_USER_ROLE)} />
          <Row label="API endpoint" value={API_BASE} mono />
          <p style={{ margin: `${tokens.space.md}px 0 0`, fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>
            V1 uses a development identity shim over the <code>x-user-id</code> / <code>x-user-role</code> headers. Full sign-in via the identity
            provider replaces this without changing application authorization.
          </p>
        </Card>

        <Card title="Human-gated actions" subtitle="Never taken autonomously in V1 (§2, §14).">
          <div style={{ display: "flex", flexDirection: "column", gap: tokens.space.sm }}>
            {HUMAN_GATED.map((action) => (
              <div key={action} style={{ display: "flex", alignItems: "center", gap: tokens.space.sm }}>
                <Badge tone="warning">Approval required</Badge>
                <span style={{ fontSize: tokens.fontSize.sm, color: tokens.color.ink }}>{action}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Security posture">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: tokens.space.lg }}>
          {SECURITY_POSTURE.map((item) => (
            <div key={item.title}>
              <div style={{ fontWeight: 600, color: tokens.color.ink, marginBottom: tokens.space.xs }}>{item.title}</div>
              <p style={{ margin: 0, fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted, lineHeight: 1.5 }}>{item.detail}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Notification channels" subtitle="Where approval requests are delivered (§14).">
        <EmptyState
          compact
          title="Configured server-side"
          description="Telegram-first with email fallback is managed by the notifications worker in V1. Per-user channel preferences will surface here in a later release."
        />
      </Card>
    </div>
  );
}
