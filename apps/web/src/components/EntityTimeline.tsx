"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { TimelineEntry } from "@opportunity-os/contracts";
import { Button, EmptyState, Timeline, formatDateTime, statusLabel, tokens, type TimelineItem, type Tone } from "@opportunity-os/ui";

type Category = "Lifecycle" | "Discovery" | "Approvals" | "Negotiation" | "Settlement" | "Evidence" | "Other";

const CATEGORY_ORDER: Category[] = ["Lifecycle", "Discovery", "Approvals", "Negotiation", "Settlement", "Evidence", "Other"];

function category(action: string): Category {
  const domain = action.split(".")[0];
  switch (domain) {
    case "mission":
    case "transaction":
      return "Lifecycle";
    case "opportunity":
      return "Discovery";
    case "approval":
      return "Approvals";
    case "negotiation":
      return "Negotiation";
    case "settlement":
    case "asset_transfer":
      return "Settlement";
    case "evidence":
      return "Evidence";
    default:
      return "Other";
  }
}

function tone(action: string): Tone {
  const a = action.toLowerCase();
  if (/(reject|dispute|freeze|frozen|cancel|fail|reversed|expired|archived)/.test(a)) return "danger";
  if (/(paused|pending|submitted|fund|requested)/.test(a)) return "warning";
  if (/(approv|settl|release|confirmed|executed|resolved)/.test(a)) return "success";
  if (/(discovered|versioned|captured)/.test(a)) return "progress";
  if (/(create|propos|draft)/.test(a)) return "info";
  return "neutral";
}

/** "settlement.recipient_payout.reversed" -> "Settlement · Recipient payout · Reversed". */
function title(action: string): string {
  return action.split(".").map(statusLabel).join(" · ");
}

/** Deep link for entities that have their own page; others render as a short id. */
function entityRef(entry: TimelineEntry): React.ReactNode {
  const short = entry.entity_id.slice(0, 8);
  if (entry.entity_type === "opportunity") return <Link href={`/opportunities/${entry.entity_id}`} className="oos-link">opportunity {short}</Link>;
  if (entry.entity_type === "transaction") return <Link href={`/transactions/${entry.entity_id}`} className="oos-link">transaction {short}</Link>;
  if (entry.entity_type === "mission") return null; // Already on the mission's own page wherever this appears.
  return `${statusLabel(entry.entity_type).toLowerCase()} ${short}`;
}

function toItem(entry: TimelineEntry): TimelineItem {
  const ref = entityRef(entry);
  return {
    id: entry.id,
    title: title(entry.action),
    at: formatDateTime(entry.at),
    tone: tone(entry.action),
    description: (
      <>
        {/* Timeline renders description inside a <p>: block-level spans, not divs. */}
        {entry.summary && <span style={{ display: "block" }}>{entry.summary}</span>}
        <span style={{ display: "block", color: tokens.color.inkSubtle }}>
          {ref}
          {ref && entry.actor ? " · " : null}
          {entry.actor ? `by ${entry.actor}` : null}
        </span>
      </>
    ),
    meta: entry.hash ? `${entry.source} · ${entry.hash.slice(0, 16)}…` : entry.source,
  };
}

export interface EntityTimelineProps {
  entries: TimelineEntry[];
  emptyTitle?: string;
  emptyDescription?: string;
}

/**
 * Merged, filterable history (Phase 4 timelines) — newest first, with a
 * category filter so a busy mission's discoveries don't bury its approvals.
 */
export function EntityTimeline({ entries, emptyTitle = "No events yet", emptyDescription }: EntityTimelineProps) {
  const [filter, setFilter] = useState<Category | "All">("All");

  const counts = useMemo(() => {
    const c = new Map<Category, number>();
    for (const e of entries) c.set(category(e.action), (c.get(category(e.action)) ?? 0) + 1);
    return c;
  }, [entries]);

  const visible = useMemo(
    () => entries.filter((e) => filter === "All" || category(e.action) === filter).slice().reverse(),
    [entries, filter],
  );

  if (entries.length === 0) return <EmptyState compact title={emptyTitle} description={emptyDescription} />;

  const categories = CATEGORY_ORDER.filter((c) => counts.has(c));
  return (
    <div className="oos-stack" style={{ gap: tokens.space.md }}>
      {categories.length > 1 && (
        <div role="group" aria-label="Filter timeline" style={{ display: "flex", flexWrap: "wrap", gap: tokens.space.xs }}>
          <Button size="sm" variant={filter === "All" ? "primary" : "ghost"} aria-pressed={filter === "All"} onClick={() => setFilter("All")}>
            All {entries.length}
          </Button>
          {categories.map((c) => (
            <Button key={c} size="sm" variant={filter === c ? "primary" : "ghost"} aria-pressed={filter === c} onClick={() => setFilter(c)}>
              {c} {counts.get(c)}
            </Button>
          ))}
        </div>
      )}
      <Timeline items={visible.map(toItem)} />
    </div>
  );
}
