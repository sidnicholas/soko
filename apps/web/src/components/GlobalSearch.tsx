"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Badge, Button, Card, EmptyState, Input, formatScore, tokens } from "@opportunity-os/ui";
import { api, type SearchResults } from "../lib/api";

const sectionLabel: React.CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize.xs,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: tokens.color.inkSubtle,
};

/** Phase 4 Search: find a mission or a live opportunity across everything the caller can see. */
export function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ q: string; data: SearchResults } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (q.length < 2) {
      setError("Type at least 2 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResults({ q, data: await api.search(q) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  }

  const empty = results && results.data.missions.length === 0 && results.data.opportunities.length === 0;
  return (
    <Card title="Search" subtitle="Your missions and the live opportunities they've found.">
      <div className="oos-stack" style={{ gap: tokens.space.md }}>
        <form role="search" onSubmit={onSubmit} style={{ display: "flex", gap: tokens.space.sm }}>
          <Input
            aria-label="Search missions and opportunities"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. monitor, Dell, Detroit"
            style={{ flex: 1, minWidth: 0 }}
          />
          <Button type="submit" variant="secondary" loading={busy}>
            Search
          </Button>
        </form>
        {error && <p style={{ margin: 0, fontSize: tokens.fontSize.sm, color: "#b02525" }}>{error}</p>}
        {empty && <EmptyState compact title={`Nothing matches “${results.q}”`} description="Try a broader word, or start a new mission below." />}
        {results && !empty && (
          <div className="oos-stack" style={{ gap: tokens.space.md }}>
            {results.data.missions.length > 0 && (
              <section className="oos-stack" style={{ gap: tokens.space.xs }}>
                <h3 style={sectionLabel}>Missions</h3>
                {results.data.missions.map((m) => (
                  <div key={m.id} style={{ display: "flex", justifyContent: "space-between", gap: tokens.space.md, alignItems: "center" }}>
                    <Link href={`/missions/${m.id}`} className="oos-link" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {m.title}
                    </Link>
                    <Badge status={m.status} />
                  </div>
                ))}
              </section>
            )}
            {results.data.opportunities.length > 0 && (
              <section className="oos-stack" style={{ gap: tokens.space.xs }}>
                <h3 style={sectionLabel}>Opportunities</h3>
                {results.data.opportunities.map((o) => (
                  <div key={o.id} style={{ display: "flex", justifyContent: "space-between", gap: tokens.space.md, alignItems: "center" }}>
                    <span style={{ minWidth: 0 }}>
                      <Link href={`/opportunities/${o.id}`} className="oos-link" style={{ display: "block", overflowWrap: "anywhere" }}>
                        {o.supply_title}
                      </Link>
                      <span style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>for {o.mission_title}</span>
                    </span>
                    <span style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkMuted, whiteSpace: "nowrap" }}>{formatScore(o.overall_score)}</span>
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
