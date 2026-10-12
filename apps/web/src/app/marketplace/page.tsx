"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Card, DataTable, EmptyState, Input, PageHeader, Select, StatCard, formatMoney, tokens, type Column } from "@opportunity-os/ui";
import { api, type MarketListing, type MarketListings } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";

const words = (s: string) => s.replaceAll("_", " ");

const ORIGIN_LABEL: Record<MarketListing["origin"], string> = {
  intel: "Web intelligence",
  marketplace: "Missions & connectors",
};

function ago(iso: string): string {
  const hours = Math.max(0, (Date.now() - Date.parse(iso)) / 3_600_000);
  return hours < 48 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`;
}

function price(l: MarketListing): string {
  return l.price_minor === null ? "—" : formatMoney({ amount: l.price_minor, currency: l.currency ?? "USD" });
}

/** Only http(s) links are rendered: lead URLs come from web search results. */
function safeUrl(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * CSV cell: quoted, and a leading = + - @ is neutralised so a scraped title
 * can't run as a formula when the file is opened in a spreadsheet.
 */
function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function toCsv(rows: MarketListing[]): string {
  const header = ["side", "type", "title", "description", "category", "price", "currency", "quantity", "location", "needed_by", "source", "url", "contact", "matched", "match_detail", "status", "origin", "created_at"];
  const lines = rows.map((l) =>
    [
      l.side,
      l.type,
      l.title,
      l.description,
      l.category,
      l.price_minor === null ? null : (l.price_minor / 100).toFixed(2),
      l.currency,
      l.quantity,
      l.location,
      l.needed_by,
      l.source,
      l.url,
      l.contact?.value ?? null,
      l.matched ? "yes" : "no",
      l.match_detail,
      l.status,
      l.origin,
      l.created_at,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\r\n");
}

function download(filename: string, rows: MarketListing[]) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function columns(side: MarketListing["side"]): Column<MarketListing>[] {
  return [
    {
      key: "title",
      header: side === "demand" ? "Wanted" : "Offered",
      render: (l) => {
        const href = safeUrl(l.url);
        return (
          <div style={{ maxWidth: "52ch" }}>
            <div style={{ fontWeight: tokens.weight.medium }}>
              {href ? (
                <a href={href} target="_blank" rel="noreferrer" className="oos-link">
                  {l.title}
                </a>
              ) : (
                l.title
              )}
              {l.type === "problem" && (
                <Badge tone="info" dot={false} style={{ marginLeft: tokens.space.xs }}>
                  problem
                </Badge>
              )}
            </div>
            {l.description !== l.title && <div style={{ color: tokens.color.inkMuted, fontSize: tokens.fontSize.xs, lineHeight: 1.4 }}>{l.description}</div>}
          </div>
        );
      },
    },
    { key: "category", header: "Category", render: (l) => (l.category ? words(l.category) : "—") },
    { key: "price", header: side === "demand" ? "Budget" : "Price", align: "right", render: price },
    { key: "quantity", header: "Qty", render: (l) => l.quantity ?? "—" },
    { key: "location", header: "Location", render: (l) => l.location ?? "—" },
    ...(side === "demand" ? [{ key: "needed_by", header: "Needed by", render: (l: MarketListing) => l.needed_by ?? "—" }] : []),
    {
      key: "source",
      header: "Source",
      render: (l) => (
        <div>
          <div>{l.source}</div>
          <div style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}>{ORIGIN_LABEL[l.origin]}</div>
        </div>
      ),
    },
    {
      key: "matched",
      header: "Other side",
      render: (l) => (
        <div>
          <Badge tone={l.matched ? "success" : "warning"}>{l.matched ? "Matched" : "Unmatched"}</Badge>
          <div style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs, marginTop: 2 }}>{words(l.match_detail)}</div>
        </div>
      ),
    },
    { key: "age", header: "Found", align: "right", render: (l) => ago(l.created_at) },
  ];
}

function ListingCard({ side, rows, total }: { side: MarketListing["side"]; rows: MarketListing[]; total: number }) {
  const title = side === "demand" ? "Demand" : "Supply";
  return (
    <Card
      flush
      title={title}
      subtitle={`${rows.length} of ${total} shown`}
      actions={
        <Button size="sm" disabled={rows.length === 0} onClick={() => download(`soko-${side}-${new Date().toISOString().slice(0, 10)}.csv`, rows)}>
          Export CSV
        </Button>
      }
    >
      <DataTable
        columns={columns(side)}
        rows={rows}
        getRowKey={(l) => l.id}
        empty={
          <EmptyState
            compact
            title={total === 0 ? `No ${side} recorded yet` : `No ${side} matches these filters`}
            description={
              total === 0
                ? side === "supply"
                  ? "Supply arrives from connectors and submitted signals. The web-intelligence sweep currently searches demand and problem venues only."
                  : "Demand arrives from missions, submitted signals and the web-intelligence sweep."
                : "Clear the filters to see everything."
            }
          />
        }
      />
    </Card>
  );
}

function Listings({ data }: { data: MarketListings }) {
  const [text, setText] = useState("");
  const [origin, setOrigin] = useState<"all" | MarketListing["origin"]>("all");
  const [unmatchedOnly, setUnmatchedOnly] = useState(true);

  const filter = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return (rows: MarketListing[]) =>
      rows.filter(
        (l) =>
          (origin === "all" || l.origin === origin) &&
          (!unmatchedOnly || !l.matched) &&
          (needle === "" || [l.title, l.description, l.category ?? "", l.location ?? "", l.source].some((f) => f.toLowerCase().includes(needle))),
      );
  }, [text, origin, unmatchedOnly]);

  const c = data.counts;
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: tokens.space.md }}>
        <StatCard label="Demand records" value={String(c.demand.total)} hint={`${c.demand.unmatched} with no supply found`} />
        <StatCard label="Supply records" value={String(c.supply.total)} hint={`${c.supply.unmatched} with no demand found`} />
      </div>
      <Card>
        <div style={{ display: "flex", flexWrap: "wrap", gap: tokens.space.md, alignItems: "center" }}>
          <Input aria-label="Filter listings" placeholder="Filter by item, category, location or source" value={text} onChange={(e) => setText(e.target.value)} style={{ flex: "1 1 280px" }} />
          <Select aria-label="Origin" value={origin} onChange={(e) => setOrigin(e.target.value as typeof origin)} style={{ width: 220 }}>
            <option value="all">All origins</option>
            <option value="intel">{ORIGIN_LABEL.intel}</option>
            <option value="marketplace">{ORIGIN_LABEL.marketplace}</option>
          </Select>
          <label style={{ display: "flex", alignItems: "center", gap: tokens.space.xs, fontSize: tokens.fontSize.sm, color: tokens.color.ink }}>
            <input type="checkbox" checked={unmatchedOnly} onChange={(e) => setUnmatchedOnly(e.target.checked)} />
            Unmatched only
          </label>
        </div>
      </Card>
      <ListingCard side="demand" rows={filter(data.demand)} total={c.demand.total} />
      <ListingCard side="supply" rows={filter(data.supply)} total={c.supply.total} />
    </>
  );
}

export default function MarketplacePage() {
  const listings = useAsync(() => api.marketListings(), []);
  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <PageHeader
        eyebrow="Discover"
        title="Marketplace"
        subtitle="Every demand and supply record Soko holds, listed on its own. Unmatched records are the ones still waiting for an opposite side you may be able to bring from outside the network."
      />
      <AsyncView state={listings} loadingLabel="Loading listings">
        {(data) => <Listings data={data} />}
      </AsyncView>
    </div>
  );
}
