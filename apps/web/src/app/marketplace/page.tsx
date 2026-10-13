"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, DataTable, EmptyState, Field, Input, PageHeader, Select, StatCard, Textarea, formatMoney, tokens, tonePalette, type Column, type Tone } from "@opportunity-os/ui";
import { api, ApiError, type MarketListing, type MarketListings, type OffNetworkMatch, type OffNetworkStatus } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";

const words = (s: string) => s.replaceAll("_", " ");

const ORIGIN_LABEL: Record<MarketListing["origin"], string> = {
  intel: "Web intelligence",
  marketplace: "Missions & connectors",
};

const DEAL_STATUSES: OffNetworkStatus[] = ["open", "contacted", "agreed", "won", "lost", "dismissed"];
const DEAL_TONE: Record<OffNetworkStatus, Tone> = { open: "info", contacted: "info", agreed: "success", won: "success", lost: "danger", dismissed: "neutral" };

/** A deal that is still in play; lost and dismissed ones no longer cover the listing. */
const live = (m: OffNetworkMatch) => m.status !== "lost" && m.status !== "dismissed";
/** Still waiting for an opposite side: the system found none and you have no live deal on it. */
const unmatched = (l: MarketListing) => !l.matched && !l.off_network.some(live);
/** What you would be bringing to this listing. */
const otherSide = (side: MarketListing["side"]) => (side === "demand" ? "supply" : "buyer");

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
  const header = ["side", "type", "title", "description", "category", "price", "currency", "quantity", "location", "needed_by", "source", "url", "contact", "matched", "match_detail", "status", "origin", "created_at", "off_network_counterparty", "off_network_status"];
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
      l.off_network.find(live)?.counterparty_name ?? null,
      l.off_network.find(live)?.status ?? null,
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

function columns(side: MarketListing["side"], onPick: (l: MarketListing) => void): Column<MarketListing>[] {
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
      render: (l) => {
        const mine = l.off_network.find(live);
        return (
          <div>
            {mine ? <Badge tone="info">Yours: {mine.counterparty_name}</Badge> : <Badge tone={l.matched ? "success" : "warning"}>{l.matched ? "Matched" : "Unmatched"}</Badge>}
            <div style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs, marginTop: 2 }}>{mine ? words(mine.status) : words(l.match_detail)}</div>
          </div>
        );
      },
    },
    { key: "age", header: "Found", align: "right", render: (l) => ago(l.created_at) },
    {
      key: "action",
      header: "",
      align: "right",
      render: (l) => (
        <Button size="sm" onClick={() => onPick(l)} style={{ whiteSpace: "nowrap" }}>
          I have the {otherSide(l.side)}
        </Button>
      ),
    },
  ];
}

function ListingCard({ side, rows, total, onPick }: { side: MarketListing["side"]; rows: MarketListing[]; total: number; onPick: (l: MarketListing) => void }) {
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
        columns={columns(side, onPick)}
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

/** "I have the other side": record the counterparty you hold outside the network against one listing. */
function OffNetworkForm({ listing, onDone, onCancel }: { listing: MarketListing; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [terms, setTerms] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bringing = otherSide(listing.side);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const major = amount.trim() === "" ? null : Number(amount);
    if (major !== null && (!Number.isFinite(major) || major < 0)) {
      setError("Price must be a positive number.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.addOffNetwork(listing.id, {
        counterparty_name: name.trim(),
        counterparty_contact: contact.trim() || null,
        terms: terms.trim() || null,
        price_minor: major === null ? null : Math.round(major * 100),
        currency: major === null ? null : (listing.currency ?? "USD"),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`I have the ${bringing}`} subtitle={`For: ${listing.title}`}>
      <form onSubmit={(e) => void submit(e)} style={{ display: "grid", gap: tokens.space.md, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
        <Field label={`Your ${bringing}`} htmlFor="off-name" hint="Person or company you can bring to this." required>
          <Input id="off-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required autoFocus />
        </Field>
        <Field label="How to reach them" htmlFor="off-contact">
          <Input id="off-contact" value={contact} onChange={(e) => setContact(e.target.value)} maxLength={300} placeholder="Email, phone or how you know them" />
        </Field>
        <Field label={listing.side === "demand" ? `Their price (${listing.currency ?? "USD"})` : `Their budget (${listing.currency ?? "USD"})`} htmlFor="off-price">
          <Input id="off-price" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="Optional" />
        </Field>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="What they offer or need" htmlFor="off-terms">
            <Textarea id="off-terms" value={terms} onChange={(e) => setTerms(e.target.value)} maxLength={2000} placeholder="Quantity, condition, timing, anything that decides whether this fits" />
          </Field>
        </div>
        {error && <div style={{ gridColumn: "1 / -1", color: tonePalette.danger.fg, fontSize: tokens.fontSize.sm }}>{error}</div>}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: tokens.space.sm }}>
          <Button type="submit" variant="primary" loading={busy} disabled={name.trim() === ""}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function DealsCard({ deals, onChange }: { deals: OffNetworkMatch[]; onChange: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  async function setStatus(deal: OffNetworkMatch, status: OffNetworkStatus) {
    setBusyId(deal.id);
    try {
      await api.setOffNetworkStatus(deal.id, { status });
      onChange();
    } finally {
      setBusyId(null);
    }
  }
  const dealColumns: Column<OffNetworkMatch>[] = [
    {
      key: "listing",
      header: "Listing",
      render: (d) => (
        <div style={{ maxWidth: "40ch" }}>
          <div style={{ fontWeight: tokens.weight.medium }}>{d.listing_title}</div>
          <div style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}>
            {d.listing_side} · you bring the {otherSide(d.listing_side)}
          </div>
        </div>
      ),
    },
    {
      key: "counterparty",
      header: "Your counterparty",
      render: (d) => (
        <div>
          <div>{d.counterparty_name}</div>
          {d.counterparty_contact && <div style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}>{d.counterparty_contact}</div>}
        </div>
      ),
    },
    { key: "terms", header: "Terms", render: (d) => <div style={{ maxWidth: "36ch", fontSize: tokens.fontSize.xs, color: tokens.color.inkMuted }}>{d.terms ?? "—"}</div> },
    { key: "price", header: "Price", align: "right", render: (d) => (d.price_minor === null ? "—" : formatMoney({ amount: d.price_minor, currency: d.currency ?? "USD" })) },
    {
      key: "status",
      header: "Status",
      render: (d) => (
        <div style={{ display: "flex", alignItems: "center", gap: tokens.space.sm }}>
          <Badge tone={DEAL_TONE[d.status]}>{words(d.status)}</Badge>
          <Select aria-label={`Status for ${d.counterparty_name}`} value={d.status} disabled={busyId === d.id} onChange={(e) => void setStatus(d, e.target.value as OffNetworkStatus)} style={{ width: 130 }}>
            {DEAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {words(s)}
              </option>
            ))}
          </Select>
        </div>
      ),
    },
    { key: "age", header: "Added", align: "right", render: (d) => ago(d.created_at) },
  ];
  return (
    <Card flush title="Your off-network deals" subtitle="Listings where you recorded the other side yourself. Move each one along as it progresses.">
      <DataTable
        columns={dealColumns}
        rows={deals}
        getRowKey={(d) => d.id}
        empty={<EmptyState compact title="No off-network deals yet" description="Use the button on any listing below when you can bring the other side from outside the network." />}
      />
    </Card>
  );
}

function Listings({ data, onChange }: { data: MarketListings; onChange: () => void }) {
  const [picked, setPicked] = useState<MarketListing | null>(null);
  const [text, setText] = useState("");
  const [origin, setOrigin] = useState<"all" | MarketListing["origin"]>("all");
  const [unmatchedOnly, setUnmatchedOnly] = useState(true);

  const filter = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return (rows: MarketListing[]) =>
      rows.filter(
        (l) =>
          (origin === "all" || l.origin === origin) &&
          (!unmatchedOnly || unmatched(l)) &&
          (needle === "" || [l.title, l.description, l.category ?? "", l.location ?? "", l.source].some((f) => f.toLowerCase().includes(needle))),
      );
  }, [text, origin, unmatchedOnly]);

  const c = data.counts;
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: tokens.space.md }}>
        <StatCard label="Demand records" value={String(c.demand.total)} hint={`${c.demand.unmatched} with no supply found`} />
        <StatCard label="Supply records" value={String(c.supply.total)} hint={`${c.supply.unmatched} with no demand found`} />
        <StatCard label="Your off-network deals" value={String(data.off_network.filter(live).length)} hint={`${data.off_network.filter((m) => m.status === "won").length} won`} />
      </div>
      {picked && (
        <OffNetworkForm
          key={picked.id}
          listing={picked}
          onCancel={() => setPicked(null)}
          onDone={() => {
            setPicked(null);
            onChange();
          }}
        />
      )}
      <DealsCard deals={data.off_network} onChange={onChange} />
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
      <ListingCard side="demand" rows={filter(data.demand)} total={c.demand.total} onPick={setPicked} />
      <ListingCard side="supply" rows={filter(data.supply)} total={c.supply.total} onPick={setPicked} />
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
        {(data) => <Listings data={data} onChange={listings.reload} />}
      </AsyncView>
    </div>
  );
}
