"use client";

import { useRef, useState } from "react";
import { Badge, Button, Card, DataTable, EmptyState, tokens, tonePalette, type Column, type Tone } from "@opportunity-os/ui";
import { api, ApiError, type IntelQuerySource, type IntelSourceImport } from "../lib/api";
import { useAsync } from "../lib/useAsync";

const words = (s: string) => s.replaceAll("_", " ");

const STATUS_TONE: Record<IntelQuerySource["status"], Tone> = { active: "success", paused: "warning", rejected: "danger" };

/**
 * Search sources added at runtime: import an agent's JSON report, see what was
 * accepted and why the rest were held, and pause or resume individual sources.
 */
export function IntelSources() {
  const sources = useAsync(() => api.intelSources(), []);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IntelSourceImport | null>(null);

  async function importFile(f: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      let document: unknown;
      try {
        document = JSON.parse(await f.text());
      } catch {
        throw new Error("That file is not valid JSON.");
      }
      setResult(await api.importIntelSources(document));
      sources.reload();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Import failed.");
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  async function toggle(s: IntelQuerySource) {
    setBusyId(s.id);
    try {
      await api.setIntelSourceStatus(s.id, s.status === "active" ? "paused" : "active");
      sources.reload();
    } finally {
      setBusyId(null);
    }
  }

  const columns: Column<IntelQuerySource>[] = [
    {
      key: "source",
      header: "Source",
      render: (s) => (
        <div style={{ maxWidth: "34ch" }}>
          <div style={{ fontWeight: tokens.weight.medium }}>{s.domain}</div>
          <div style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}>
            {s.name}
            {s.sector ? ` · ${s.sector}` : ""}
          </div>
        </div>
      ),
    },
    { key: "side", header: "Side", render: (s) => s.orientation },
    { key: "topics", header: "Searched for", render: (s) => <div style={{ maxWidth: "30ch", fontSize: tokens.fontSize.xs, color: tokens.color.inkMuted }}>{s.topics.join(" · ")}</div> },
    {
      key: "status",
      header: "Status",
      render: (s) => (
        <div>
          <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
          {s.status_reason && <div style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs, marginTop: 2 }}>{words(s.status_reason)}</div>}
        </div>
      ),
    },
    { key: "searches", header: "Searches", align: "right", render: (s) => s.yield.searches },
    { key: "leads", header: "Leads", align: "right", render: (s) => s.yield.leads },
    { key: "actionable", header: "Actionable", align: "right", render: (s) => s.yield.actionable },
    {
      key: "action",
      header: "",
      align: "right",
      render: (s) =>
        s.status === "rejected" ? null : (
          <Button size="sm" disabled={busyId === s.id} onClick={() => void toggle(s)}>
            {s.status === "active" ? "Pause" : "Resume"}
          </Button>
        ),
    },
  ];

  const rows = sources.data ?? [];
  const active = rows.filter((s) => s.status === "active").length;
  return (
    <Card
      flush
      title="Sources"
      subtitle={`Sites added from your agent's reports, searched alongside the built-in list. ${active} active of ${rows.length}. A source searched three times without a lead is paused automatically.`}
      actions={
        <>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            aria-label="Sources JSON file"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
            }}
          />
          <Button size="sm" loading={busy} onClick={() => file.current?.click()}>
            Import JSON
          </Button>
        </>
      }
    >
      {(error || result) && (
        <div style={{ padding: `${tokens.space.sm}px ${tokens.space.lg}px`, fontSize: tokens.fontSize.sm, borderBottom: `1px solid ${tokens.color.border}` }}>
          {error && <span style={{ color: tonePalette.danger.fg }}>{error}</span>}
          {result && (
            <span>
              Read {result.received} sources: {result.added_active} now searched, {result.added_paused} held, {result.already_known} already known, {result.rejected} rejected.
            </span>
          )}
        </div>
      )}
      {sources.error && rows.length === 0 ? (
        <div style={{ padding: tokens.space.lg, fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>Couldn&apos;t load sources: {sources.error}</div>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(s) => s.id}
          empty={<EmptyState compact title="No added sources yet" description="Import your agent's JSON report to add its sources to the search pool." />}
        />
      )}
    </Card>
  );
}
