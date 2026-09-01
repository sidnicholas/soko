"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Mission, MissionStatus } from "@opportunity-os/contracts";
import { Badge, Card, DataTable, EmptyState, PageHeader, formatDateTime, statusLabel, tokens } from "@opportunity-os/ui";
import { api } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";

type Filter = "all" | "active" | "paused" | "archived" | "completed";
const FILTERS: Filter[] = ["all", "active", "paused", "archived", "completed"];

const matchesFilter = (m: Mission, f: Filter): boolean => f === "all" || m.status === (f as MissionStatus);

export default function ArchivePage() {
  const router = useRouter();
  const missions = useAsync<Mission[]>(() => api.listMissions(), []);
  const [filter, setFilter] = useState<Filter>("all");

  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <PageHeader
        eyebrow="Archive"
        title="Mission history"
        subtitle="Every mission you've created — active, paused, archived, or completed. Missions are persistent and reusable (§15.4)."
        actions={
          <Link href="/" className="oos-link">
            New mission
          </Link>
        }
      />

      <div style={{ display: "flex", gap: tokens.space.sm, flexWrap: "wrap" }}>
        {FILTERS.map((f) => {
          const on = filter === f;
          return (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
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
                textTransform: "capitalize",
              }}
            >
              {f}
            </button>
          );
        })}
      </div>

      <Card flush>
        <AsyncView state={missions} loadingLabel="Loading missions">
          {(all) => {
            const rows = all.filter((m) => matchesFilter(m, filter));
            return rows.length === 0 ? (
              <EmptyState
                title={filter === "all" ? "No missions yet" : `No ${filter} missions`}
                description={filter === "all" ? "Create your first mission to start discovering opportunities." : "Try a different filter, or create a new mission."}
                action={
                  <Link href="/" className="oos-link">
                    Go to Search / Ask
                  </Link>
                }
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
                      <Link href={`/missions/${m.id}`} className="oos-link">
                        {m.title}
                      </Link>
                    ),
                  },
                  { key: "status", header: "Status", render: (m) => <Badge status={m.status} />, width: 130 },
                  { key: "policy", header: "Autonomy", render: (m) => <span style={{ color: tokens.color.inkMuted }}>{statusLabel(m.agent_autonomy_policy)}</span> },
                  { key: "created", header: "Created", align: "right", render: (m) => formatDateTime(m.created_at) },
                  { key: "archived", header: "Archived", align: "right", render: (m) => formatDateTime(m.archived_at) },
                ]}
              />
            );
          }}
        </AsyncView>
      </Card>
    </div>
  );
}
