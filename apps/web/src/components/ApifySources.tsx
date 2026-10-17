"use client";

import { useState } from "react";
import { Badge, Button, Card, DataTable, EmptyState, Field, Input, Select, Textarea, tokens, tonePalette, type Tone } from "@opportunity-os/ui";
import { api, type ApifyFieldMapInput, type ApifyRunRow, type ApifySourceDetail, type QuarantinedItem } from "../lib/api";
import { useAsync } from "../lib/useAsync";

const words = (s: string) => s.replaceAll("_", " ");
const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);
const num = { fontVariantNumeric: "tabular-nums" } as const;
const RUN_TONE: Record<ApifyRunRow["status"], Tone> = { running: "progress", ingesting: "progress", succeeded: "success", failed: "danger" };

const SEARCH_PLAN_EXAMPLE = JSON.stringify(
  {
    urlTemplate: "https://www.facebook.com/marketplace/{city}/search/?query={query}",
    cities: ["detroit"],
    queries: ["pallet tools", "contractor surplus", "lot of appliances"],
    fromDemand: true,
    perRun: 5,
    searchUrlField: "facebookUrl",
  },
  null,
  2,
);

const EXAMPLE_MAP: ApifyFieldMapInput = { kind: "supply", externalId: "id", title: "title", description: "description", url: "url", price: "price", currency: "const:USD", category: "category" };

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

/**
 * Register an Apify actor as a source (ADR-042). It arrives proposed: it runs
 * only after a policy review records written permission (or a provider
 * contract or official API terms), data-use constraints and a pinned build.
 */
export function RegisterApifySource({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [orientation, setOrientation] = useState<"supply" | "demand">("supply");
  const [actorId, setActorId] = useState("");
  const [version, setVersion] = useState("");
  const [input, setInput] = useState("{}");
  const [fieldMap, setFieldMap] = useState(JSON.stringify(EXAMPLE_MAP, null, 2));
  const [maxItems, setMaxItems] = useState("200");
  const [maxCharge, setMaxCharge] = useState("0.50");
  const [runInterval, setRunInterval] = useState("1440");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      await api.registerApifySource({
        name: name.trim(),
        domain: domain.trim(),
        orientation,
        actorId: actorId.trim(),
        actorVersion: version.trim(),
        input: parseJson<Record<string, unknown>>(input, "Actor input"),
        fieldMap: parseJson<ApifyFieldMapInput>(fieldMap, "Field map"),
        maxItems: maxItems ? Number(maxItems) : null,
        maxChargeUsd: maxCharge ? Number(maxCharge) : null,
        minIntervalMinutes: runInterval ? Number(runInterval) : null,
        evidenceUrl: evidence.trim() || null,
      });
      setMessage("Registered. Review it below (Needs review) to record the permission before it can run.");
      setOpen(false);
      onDone();
    } catch (err) {
      setMessage(errorText(err, "Could not register the actor"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Apify actors"
      subtitle="An actor fetches a site for us, so it needs that site's written permission, a provider contract or official API terms, plus data-use limits and a fixed build. Its output is checked item by item; anything unexpected waits in quarantine."
      actions={
        !open && (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Register an actor
          </Button>
        )
      }
    >
      {message && <div style={{ fontSize: tokens.fontSize.sm, marginBottom: tokens.space.sm }}>{message}</div>}
      {open && (
        <div className="oos-stack" style={{ gap: tokens.space.md }}>
          <div style={{ display: "grid", gap: tokens.space.md, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
            <Field label="Name" htmlFor="ap-name">
              <Input id="ap-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="GovDeals surplus listings" />
            </Field>
            <Field label="Site it reads" htmlFor="ap-domain">
              <Input id="ap-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="govdeals.com" />
            </Field>
            <Field label="Side" htmlFor="ap-side">
              <Select id="ap-side" value={orientation} onChange={(e) => setOrientation(e.target.value as "supply" | "demand")}>
                <option value="supply">Supply (things for sale)</option>
                <option value="demand">Demand (buying requests)</option>
              </Select>
            </Field>
            <Field label="Actor" htmlFor="ap-actor" hint="username~actor-name">
              <Input id="ap-actor" value={actorId} onChange={(e) => setActorId(e.target.value)} />
            </Field>
            <Field label="Build" htmlFor="ap-build" hint="A fixed build number such as 0.1.23, not latest.">
              <Input id="ap-build" value={version} onChange={(e) => setVersion(e.target.value)} />
            </Field>
            <Field label="Items per run (max 1000)" htmlFor="ap-items">
              <Input id="ap-items" type="number" min={1} max={1000} value={maxItems} onChange={(e) => setMaxItems(e.target.value)} />
            </Field>
            <Field label="Cost cap per run (USD)" htmlFor="ap-charge">
              <Input id="ap-charge" type="number" min={0.01} step={0.01} value={maxCharge} onChange={(e) => setMaxCharge(e.target.value)} />
            </Field>
            <Field label="Minutes between runs" htmlFor="ap-int">
              <Input id="ap-int" type="number" min={1} value={runInterval} onChange={(e) => setRunInterval(e.target.value)} />
            </Field>
            <Field label="Permission evidence (link)" htmlFor="ap-ev">
              <Input id="ap-ev" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Where the written permission is kept" />
            </Field>
          </div>
          <Field label="Actor input (JSON)" htmlFor="ap-input" hint="Exactly what the actor receives on every run.">
            <Textarea id="ap-input" value={input} onChange={(e) => setInput(e.target.value)} style={{ fontFamily: "monospace", minHeight: 90 }} />
          </Field>
          <Field
            label="Field map (JSON)"
            htmlFor="ap-map"
            hint='Which item field holds what: paths like "price.value", or constants like "const:USD". externalId and title are required. Fields the actor returns that are not mapped are learnt from the first run; after that, a new field sends the item to quarantine.'
          >
            <Textarea id="ap-map" value={fieldMap} onChange={(e) => setFieldMap(e.target.value)} style={{ fontFamily: "monospace", minHeight: 180 }} />
          </Field>
          <div style={{ display: "flex", gap: tokens.space.sm }}>
            <Button size="sm" loading={busy} disabled={!name.trim() || !domain.trim() || !actorId.trim() || !version.trim()} onClick={() => void submit()}>
              Register
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** An actor source's configuration, runs and quarantine, inside its Source Registry detail. */
export function ApifySourcePanel({ id, active, onChange }: { id: string; active: boolean; onChange: () => void }) {
  const detail = useAsync(() => api.apifySource(id), [id]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [mapText, setMapText] = useState("");
  const [inputText, setInputText] = useState("");
  const [planText, setPlanText] = useState("");

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage(done);
      detail.reload();
      onChange();
      return true;
    } catch (err) {
      setMessage(errorText(err, "Failed"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const d = detail.data;
  if (!d) return detail.error ? <div style={{ color: tonePalette.danger.fg, fontSize: tokens.fontSize.sm }}>{detail.error}</div> : null;
  return (
    <div className="oos-stack" style={{ gap: tokens.space.lg }}>
      <Card
        title="Actor configuration"
        actions={
          <div style={{ display: "flex", gap: tokens.space.sm }}>
            {active && (
              <Button size="sm" loading={busy} onClick={() => void act(() => api.runApifySource(id), "Run started. Results arrive when Apify calls back, or on the next connector sweep.")}>
                Run now
              </Button>
            )}
            {!editing && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMapText(JSON.stringify(d.config.fieldMap, null, 2));
                  setInputText(JSON.stringify(d.config.input ?? {}, null, 2));
                  setPlanText(d.config.searchPlan ? JSON.stringify(d.config.searchPlan, null, 2) : "");
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            )}
          </div>
        }
      >
        {message && <div style={{ fontSize: tokens.fontSize.sm, marginBottom: tokens.space.sm }}>{message}</div>}
        {editing ? (
          <div className="oos-stack" style={{ gap: tokens.space.md }}>
            <Field label="Actor input (JSON)" htmlFor={`ai-${id}`}>
              <Textarea id={`ai-${id}`} value={inputText} onChange={(e) => setInputText(e.target.value)} style={{ fontFamily: "monospace", minHeight: 90 }} />
            </Field>
            <Field label="Field map (JSON)" htmlFor={`am-${id}`}>
              <Textarea id={`am-${id}`} value={mapText} onChange={(e) => setMapText(e.target.value)} style={{ fontFamily: "monospace", minHeight: 180 }} />
            </Field>
            <Field
              label="Search plan (JSON, optional)"
              htmlFor={`ap-${id}`}
              hint='Builds the search URLs each run: what buyers asked for lately first (fromDemand), then queries × cities in rotation; searches that keep finding nothing new drop down. Empty keeps the input fixed.'
            >
              <Textarea id={`ap-${id}`} value={planText} onChange={(e) => setPlanText(e.target.value)} placeholder={SEARCH_PLAN_EXAMPLE} style={{ fontFamily: "monospace", minHeight: 160 }} />
            </Field>
            <div style={{ display: "flex", gap: tokens.space.sm }}>
              <Button
                size="sm"
                loading={busy}
                onClick={async () => {
                  const ok = await act(
                    () =>
                      api.configureApifySource(id, {
                        input: parseJson<Record<string, unknown>>(inputText, "Actor input"),
                        fieldMap: parseJson<ApifyFieldMapInput>(mapText, "Field map"),
                        searchPlan: planText.trim() ? parseJson<Record<string, unknown>>(planText, "Search plan") : null,
                      }),
                    "Saved.",
                  );
                  if (ok) setEditing(false);
                }}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: tokens.space.md, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", fontSize: tokens.fontSize.xs }}>
            <div>
              <div style={{ color: tokens.color.inkSubtle }}>Field map</div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(d.config.fieldMap, null, 2)}</pre>
            </div>
            <div>
              <div style={{ color: tokens.color.inkSubtle }}>Input</div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(d.config.input, null, 2)}</pre>
              <div style={{ color: tokens.color.inkSubtle, marginTop: tokens.space.sm }}>
                Up to {d.config.maxItems ?? 1000} items and ${d.config.maxChargeUsd?.toFixed(2) ?? "—"} per run
              </div>
              <div style={{ color: tokens.color.inkSubtle, marginTop: tokens.space.sm }}>
                Expected fields: {d.config.expectedFields ? d.config.expectedFields.join(", ") : "learnt from the first run"}
              </div>
              {d.config.searchPlan && (
                <>
                  <div style={{ color: tokens.color.inkSubtle, marginTop: tokens.space.sm }}>Search plan</div>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(d.config.searchPlan, null, 2)}</pre>
                </>
              )}
            </div>
          </div>
        )}
      </Card>
      {d.lastSearches.length > 0 && (
        <Card title="Latest run's searches" flush>
          <DataTable
            columns={[
              { key: "term", header: "Search", render: (s: ApifySourceDetail["lastSearches"][number]) => <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="oos-link">{s.term}</a> },
              { key: "city", header: "City", render: (s: ApifySourceDetail["lastSearches"][number]) => s.city ?? "—" },
              { key: "origin", header: "From", render: (s: ApifySourceDetail["lastSearches"][number]) => <Badge tone={s.origin === "demand" ? "accent" : "neutral"}>{s.origin === "demand" ? "buyer demand" : "list"}</Badge> },
              { key: "items", header: "Items", align: "right", render: (s: ApifySourceDetail["lastSearches"][number]) => <span style={num}>{s.items}</span> },
              { key: "new", header: "New", align: "right", render: (s: ApifySourceDetail["lastSearches"][number]) => <span style={num}>{s.items_new}</span> },
            ]}
            rows={d.lastSearches}
            getRowKey={(s) => s.url}
          />
        </Card>
      )}
      <Card title="Actor runs" flush>
        <DataTable
          columns={[
            { key: "when", header: "Started (UTC)", render: (r: ApifyRunRow) => r.started_at.slice(0, 16).replace("T", " ") },
            { key: "status", header: "Status", render: (r: ApifyRunRow) => <Badge tone={RUN_TONE[r.status]}>{r.status}</Badge> },
            { key: "items", header: "Items", align: "right", render: (r: ApifyRunRow) => <span style={num}>{r.items_total}</span> },
            { key: "new", header: "New / changed", align: "right", render: (r: ApifyRunRow) => <span style={num}>{r.items_new} / {r.items_changed}</span> },
            { key: "dup", header: "Repeat", align: "right", render: (r: ApifyRunRow) => <span style={num}>{r.items_duplicate}</span> },
            { key: "merged", header: "Merged", align: "right", render: (r: ApifyRunRow) => <span style={num}>{r.items_merged}</span> },
            { key: "q", header: "Held", align: "right", render: (r: ApifyRunRow) => <span style={num}>{r.items_quarantined}</span> },
            { key: "cost", header: "Cost", align: "right", render: (r: ApifyRunRow) => <span style={num}>{r.usage_usd !== null ? `$${r.usage_usd.toFixed(3)}` : "—"}</span> },
            {
              key: "error",
              header: "Error",
              render: (r: ApifyRunRow) =>
                r.error ? (
                  <span style={{ fontSize: tokens.fontSize.xs, color: tonePalette.danger.fg }}>
                    {r.error.slice(0, 80)}
                    {r.retry_after ? ` · retry after ${r.retry_after.slice(0, 16).replace("T", " ")}` : ""}
                  </span>
                ) : null,
            },
          ]}
          rows={d.runs}
          getRowKey={(r) => r.id}
          empty={<EmptyState compact title="No runs yet" description="Runs start once the source is active, on the connector sweep or with Run now." />}
        />
      </Card>
    </div>
  );
}

function itemPreview(item: unknown): string {
  const text = JSON.stringify(item, null, 1) ?? "";
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

/** Items held back from ingestion, across every source. */
export function QuarantineCard() {
  const items = useAsync(() => api.quarantine(), []);
  const status = useAsync(() => api.apifyStatus(), []);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);

  async function decide(q: QuarantinedItem, decision: "release" | "discard", acceptFields = false) {
    setBusy(q.id);
    setError(null);
    try {
      await api.decideQuarantine(q.id, decision, acceptFields);
      items.reload();
    } catch (err) {
      setError(errorText(err, "Failed"));
    } finally {
      setBusy(null);
    }
  }

  const rows = items.data ?? [];
  if (rows.length === 0 && !items.error) return null;
  return (
    <Card
      title={`Quarantine (${rows.length})`}
      subtitle="Actor items that did not match what the source is expected to return. Items held for new fields can be released; an unknown category value (such as a Facebook category id) can be mapped to one of ours, which releases every item held for it and applies to future runs."
    >
      {error && <div style={{ color: tonePalette.danger.fg, fontSize: tokens.fontSize.sm }}>{error}</div>}
      {items.error && <div style={{ color: tonePalette.danger.fg, fontSize: tokens.fontSize.sm }}>{items.error}</div>}
      {rows.map((q) => (
        <div key={q.id} style={{ borderBottom: `1px solid ${tokens.color.border}`, padding: `${tokens.space.sm}px 0`, fontSize: tokens.fontSize.sm }}>
          <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap" }}>
            <Badge tone={q.reason === "prompt_injection" ? "danger" : "warning"}>{words(q.reason)}</Badge>
            <span>{q.source_name}</span>
            {q.external_id && <span style={{ color: tokens.color.inkSubtle }}>#{q.external_id}</span>}
            <span style={{ color: tokens.color.inkMuted, fontSize: tokens.fontSize.xs }}>{q.fields.join(", ")}</span>
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="ghost" onClick={() => setShown(shown === q.id ? null : q.id)}>
              {shown === q.id ? "Hide" : "Show item"}
            </Button>
            {q.reason === "category_unmapped" && q.fields[0] && q.fields[0] !== "(none)" && (
              <>
                <Select
                  aria-label={`Category for ${q.fields[0]}`}
                  value={chosen[q.id] ?? ""}
                  onChange={(e) => setChosen({ ...chosen, [q.id]: e.target.value })}
                  style={{ width: 170 }}
                >
                  <option value="">Category…</option>
                  {(status.data?.categories ?? []).map((c) => (
                    <option key={c} value={c}>
                      {words(c)}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!chosen[q.id]}
                  loading={busy === q.id}
                  onClick={async () => {
                    setBusy(q.id);
                    setError(null);
                    try {
                      await api.mapQuarantinedCategory(q.id, chosen[q.id]!);
                      items.reload();
                    } catch (err) {
                      setError(errorText(err, "Failed"));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Map and release all
                </Button>
              </>
            )}
            {q.reason === "unexpected_fields" && (
              <>
                <Button size="sm" variant="secondary" loading={busy === q.id} onClick={() => void decide(q, "release", true)}>
                  Accept fields and release
                </Button>
                <Button size="sm" variant="ghost" loading={busy === q.id} onClick={() => void decide(q, "release")}>
                  Release once
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" loading={busy === q.id} onClick={() => void decide(q, "discard")}>
              Discard
            </Button>
          </div>
          {shown === q.id && <pre style={{ margin: `${tokens.space.xs}px 0 0`, fontSize: tokens.fontSize.xs, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{itemPreview(q.item)}</pre>}
        </div>
      ))}
    </Card>
  );
}
