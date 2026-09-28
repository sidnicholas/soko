"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { MissionStatus } from "@opportunity-os/contracts";
import { Badge, Card, DataTable, EmptyState, Input, PageHeader, formatDateTime, statusLabel, tokens } from "@opportunity-os/ui";
import { api, type MissionListItem } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";

type Filter = "all" | "active" | "paused" | "archived" | "completed" | "shared";
const FILTERS: Filter[] = ["all", "active", "paused", "archived", "completed", "shared"];
const FILTER_LABEL: Record<Filter, string> = { all: "All", active: "Active", paused: "Paused", archived: "Archived", completed: "Completed", shared: "Shared with me" };

const matchesFilter = (m: MissionListItem, f: Filter): boolean =>
  f === "all" || (f === "shared" ? m.access !== "owner" : m.status === (f as MissionStatus));

const matchesText = (m: MissionListItem, text: string): boolean => {
  const q = text.trim().toLowerCase();
  return q.length === 0 || m.title.toLowerCase().includes(q) || m.raw_intent.toLowerCase().includes(q);
};

export default function ArchivePage() {
  const router = useRouter();
  const missions = useAsync<MissionListItem[]>(() => api.listMissions(), []);
  const [filter, setFilter] = useState<Filter>("all");
  const [text, setText] = useState("");

  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <PageHeader
        eyebrow="Archive"
        title="Mission history"
        subtitle="Every mission you own or that was shared with you — most recently active first. Missions are persistent and reusable (§15.4)."
        actions={
          <Link href="/" className="oos-link">
            New mission
          </Link>
        }
      />

      <div style={{ display: "flex", gap: tokens.space.sm, flexWrap: "wrap", alignItems: "center" }}>
        <Input
          aria-label="Filter missions by text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Filter by title or request"
          style={{ flex: "1 1 220px", maxWidth: 320 }}
        />
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
              }}
            >
              {FILTER_LABEL[f]}
            </button>
          );
        })}
      </div>

      <Card flush>
        <AsyncView state={missions} loadingLabel="Loading missions">
          {(all) => {
            const rows = all
              .filter((m) => matchesFilter(m, filter) && matchesText(m, text))
              .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
            const unfiltered = filter === "all" && !text.trim();
            return rows.length === 0 ? (
              <EmptyState
                title={unfiltered ? "No missions yet" : "No matching missions"}
                description={unfiltered ? "Create your first mission to start discovering opportunities." : "Try a different filter, or create a new mission."}
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
                      <span style={{ display: "flex", flexDirection: "column" }}>
                        <Link href={`/missions/${m.id}`} className="oos-link">
                          {m.title}
                        </Link>
                        {m.access !== "owner" && <span style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>Shared with you · {m.access}</span>}
                      </span>
                    ),
                  },
                  { key: "status", header: "Status", render: (m) => <Badge status={m.status} />, width: 130 },
                  { key: "policy", header: "Autonomy", render: (m) => <span style={{ color: tokens.color.inkMuted }}>{statusLabel(m.agent_autonomy_policy)}</span> },
                  { key: "opps", header: "Opportunities", align: "right", render: (m) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{m.opportunity_count}</span> },
                  { key: "activity", header: "Last activity", align: "right", render: (m) => formatDateTime(m.last_activity_at) },
                  { key: "created", header: "Created", align: "right", render: (m) => formatDateTime(m.created_at) },
                ]}
              />
            );
          }}
        </AsyncView>
      </Card>
    </div>
  );
}
