"use client";

import { useRef, useState } from "react";
import { Badge, Button, Card, DataTable, EmptyState, Field, Input, PageHeader, Select, Textarea, tokens, tonePalette, type Column, type Tone } from "@opportunity-os/ui";
import { api, ApiError, type PermissionBasis, type RegistrySource, type SourceImport } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";
import { ApifySourcePanel, QuarantineCard, RegisterApifySource } from "../../components/ApifySources";

const words = (s: string) => s.replaceAll("_", " ");
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
const num = { fontVariantNumeric: "tabular-nums" } as const;

const STATUS_TONE: Record<RegistrySource["status"], Tone> = { proposed: "info", active: "success", paused: "warning", rejected: "danger" };
const HEALTH_TONE: Record<RegistrySource["health"], Tone> = { unknown: "neutral", ok: "success", degraded: "warning", failing: "danger" };
const FILTERS = ["needs review", "active", "paused", "rejected", "all"] as const;
type Filter = (typeof FILTERS)[number];

const BASES: { value: PermissionBasis; label: string }[] = [
  { value: "public_search_index", label: "Public search index (site: filter, no fetch)" },
  { value: "official_api_terms", label: "Official API under its terms" },
  { value: "written_permission", label: "Written permission from the site" },
  { value: "provider_contract", label: "Contract with a data provider" },
  { value: "owner_risk_acceptance", label: "No permission: owner accepts the risk (admin, max 90 days)" },
  { value: "none", label: "None" },
];

function matches(s: RegistrySource, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "needs review") return s.status === "proposed" || (s.status === "active" && s.policy_gaps.length > 0);
  return s.status === f;
}

/** Pausing with this reason marks a source the owner left out on purpose, not one that failed. */
const EXCLUDED = "excluded_from_sweeps";

/**
 * Checkbox for whether a source takes part in sweeps: checked is active, unchecked is paused.
 * Only active and paused sources can change; a proposed source needs a review first.
 */
function SweepToggle({ s, onChange }: { s: RegistrySource; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = s.status === "active" || s.status === "paused";
  const title = editable ? (s.status === "active" ? "In upcoming sweeps. Uncheck to leave it out." : "Left out of sweeps. Check to include it.") : s.status === "proposed" ? "Review this source first." : "Rejected sources never run.";

  async function toggle(include: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.setSourceStatus(s.id, include ? "active" : "paused", include ? undefined : EXCLUDED);
      onChange();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Change failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <label title={error ?? title} style={{ display: "inline-flex", alignItems: "center", gap: tokens.space.xs, cursor: editable && !busy ? "pointer" : "not-allowed" }}>
      <input
        type="checkbox"
        aria-label={`Include ${s.name} in sweeps`}
        checked={s.status === "active"}
        disabled={!editable || busy}
        onChange={(e) => void toggle(e.target.checked)}
      />
      {error && <span style={{ fontSize: tokens.fontSize.xs, color: tonePalette.danger.fg, maxWidth: "20ch" }}>{error}</span>}
    </label>
  );
}

/** Permission-policy review for one source (PRD v2 FR-01). Approval activates it only if every gap is closed. */
function ReviewForm({ s, onDone }: { s: RegistrySource; onDone: () => void }) {
  const [basis, setBasis] = useState<PermissionBasis>(s.permission_basis === "none" ? (s.kind === "connector" ? "official_api_terms" : s.kind === "apify_actor" ? "written_permission" : "public_search_index") : s.permission_basis);
  const [tos, setTos] = useState(s.robots_tos_assessment ?? (s.kind === "search_venue" ? "Queried only through the search provider's index with a site: filter; no page on the site is fetched." : s.kind === "apify_actor" ? "The actor fetches the site's pages. Permission: (who granted it, when, what it covers)." : ""));
  const [dataUse, setDataUse] = useState(s.data_use_constraints ?? "");
  const [due, setDue] = useState(new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [include, setInclude] = useState(s.status !== "paused");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(decision: "approved" | "rejected") {
    setBusy(true);
    setMessage(null);
    try {
      const out = await api.reviewSource(s.id, {
        decision,
        permission_basis: basis,
        robots_tos_assessment: tos.trim() || null,
        data_use_constraints: dataUse.trim() || null,
        terms_review_due_at: new Date(`${due}T00:00:00Z`).toISOString(),
        notes: notes.trim() || null,
      });
      // Approval activates the source; leave it paused when the owner does not want it swept yet.
      if (decision === "approved" && out.status === "active" && !include) {
        await api.setSourceStatus(s.id, "paused", EXCLUDED);
        setMessage("Approved, and left out of sweeps until you check it in the list.");
      } else setMessage(out.status === "active" ? "Approved: the source runs from the next sweep." : decision === "rejected" ? "Rejected." : `Recorded, still not runnable: ${out.policy_gaps.map(words).join(", ")}.`);
      onDone();
    } catch (err) {
      setMessage(err instanceof ApiError || err instanceof Error ? err.message : "Review failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: tokens.space.md, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
      <Field label="Permission basis" htmlFor={`basis-${s.id}`}>
        <Select
          id={`basis-${s.id}`}
          value={basis}
          onChange={(e) => {
            const next = e.target.value as PermissionBasis;
            setBasis(next);
            // A risk acceptance lasts at most 90 days (ADR-043).
            if (next === "owner_risk_acceptance") setDue(new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10));
          }}
        >
          {BASES.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Review valid until" htmlFor={`due-${s.id}`}>
        <Input id={`due-${s.id}`} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      </Field>
      <Field label="Robots / terms assessment" htmlFor={`tos-${s.id}`} hint="What the site's robots.txt and terms allow, and how this source is used.">
        <Textarea id={`tos-${s.id}`} value={tos} onChange={(e) => setTos(e.target.value)} />
      </Field>
      <Field label="Data-use constraints" htmlFor={`use-${s.id}`} hint="What may be kept and for how long. Required for Apify actors.">
        <Textarea id={`use-${s.id}`} value={dataUse} onChange={(e) => setDataUse(e.target.value)} />
      </Field>
      <Field
        label={basis === "owner_risk_acceptance" ? "Risk accepted (required)" : "Notes"}
        htmlFor={`notes-${s.id}`}
        hint={basis === "owner_risk_acceptance" ? "The site does not permit this. Say what risk you accept and why; it is kept in the review history and audit log. Admins only." : undefined}
      >
        <Input id={`notes-${s.id}`} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: tokens.space.xs, fontSize: tokens.fontSize.sm, width: "100%" }}>
          <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} /> Include in upcoming sweeps once approved
        </label>
        <Button variant="primary" loading={busy} onClick={() => void submit("approved")}>
          Approve
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => void submit("rejected")}>
          Reject
        </Button>
        {message && <span style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>{message}</span>}
      </div>
    </div>
  );
}

/** Bulk review covers search venues only: connectors and Apify actors each need their own permission basis. */
const bulkReviewable = (s: RegistrySource) => s.kind === "search_venue" && (s.status === "proposed" || s.status === "paused");

/**
 * One permission-policy review applied to every selected search venue. Each
 * source still gets its own review record, audit event and policy check;
 * this only saves filling in the same form for each.
 */
function BulkApprove({ selected, onDone, onClear }: { selected: RegistrySource[]; onDone: (approved: string[], summary: { text: string; tone: Tone }[]) => void; onClear: () => void }) {
  const [tos, setTos] = useState("Queried only through the search provider's index with a site: filter; no page on the site is fetched.");
  const [dataUse, setDataUse] = useState("Search result titles and snippets only; a lead keeps a short summary and the result URL. No bulk copying of listings.");
  const [due, setDue] = useState(new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [include, setInclude] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  async function run() {
    const approved: string[] = [];
    const waiting: string[] = [];
    const failed: string[] = [];
    setProgress({ done: 0, total: selected.length });
    // One at a time: each review is its own transaction, and a failure stops only that source.
    for (const [i, s] of selected.entries()) {
      try {
        const out = await api.reviewSource(s.id, {
          decision: "approved",
          permission_basis: "public_search_index",
          robots_tos_assessment: tos.trim() || null,
          data_use_constraints: dataUse.trim() || null,
          terms_review_due_at: new Date(`${due}T00:00:00Z`).toISOString(),
          notes: notes.trim() || "Approved with others from the source list.",
        });
        if (out.status === "active") {
          if (!include) await api.setSourceStatus(s.id, "paused", EXCLUDED);
          approved.push(s.id);
        } else waiting.push(`${s.name} (${s.orientation}): ${out.policy_gaps.map(words).join(", ")}`);
      } catch (err) {
        failed.push(`${s.name} (${s.orientation}): ${err instanceof Error ? err.message : "failed"}`);
      }
      setProgress({ done: i + 1, total: selected.length });
    }
    setProgress(null);
    const summary: { text: string; tone: Tone }[] = [
      { tone: "success", text: `${approved.length} approved${approved.length > 0 ? (include ? ", running from the next sweep." : ", left out of sweeps until you check them.") : "."}` },
    ];
    if (waiting.length > 0) summary.push({ tone: "warning", text: `Recorded but not runnable: ${waiting.join("; ")}` });
    if (failed.length > 0) summary.push({ tone: "danger", text: `Failed: ${failed.join("; ")}` });
    onDone(approved, summary);
  }

  const busy = progress !== null;
  return (
    <Card
      title={`Approve ${selected.length} selected`}
      subtitle="Search venues only, on the public search index basis. Every source gets its own review record and audit entry."
      actions={
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClear}>
          Clear selection
        </Button>
      }
    >
      <div className="oos-stack" style={{ gap: tokens.space.md }}>
        <div style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>
          {selected.map((s) => `${s.name} (${s.orientation})`).join(" · ")}
        </div>
        <div style={{ display: "grid", gap: tokens.space.md, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          <Field label="Robots / terms assessment" htmlFor="bulk-tos">
            <Textarea id="bulk-tos" value={tos} onChange={(e) => setTos(e.target.value)} />
          </Field>
          <Field label="Data-use constraints" htmlFor="bulk-use">
            <Textarea id="bulk-use" value={dataUse} onChange={(e) => setDataUse(e.target.value)} />
          </Field>
          <Field label="Review valid until" htmlFor="bulk-due">
            <Input id="bulk-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
          <Field label="Notes" htmlFor="bulk-notes">
            <Input id="bulk-notes" value={notes} placeholder="Approved with others from the source list." onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: tokens.space.xs, fontSize: tokens.fontSize.sm }}>
          <input type="checkbox" checked={include} disabled={busy} onChange={(e) => setInclude(e.target.checked)} /> Include them in upcoming sweeps once approved
        </label>
        <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap" }}>
          <Button variant="primary" loading={busy} disabled={!tos.trim()} onClick={() => void run()}>
            Approve {selected.length}
          </Button>
          {progress && (
            <span style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>
              Approving {progress.done} of {progress.total}…
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

function SourceDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const detail = useAsync(() => api.getSource(id), [id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(s: RegistrySource) {
    setBusy(true);
    setError(null);
    try {
      await api.setSourceStatus(s.id, s.status === "active" ? "paused" : "active");
      detail.reload();
      onChange();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Change failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AsyncView state={detail} loadingLabel="Loading source">
      {(s) => (
        <div className="oos-stack" style={{ gap: tokens.space.lg }}>
          <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap" }}>
            {s.policy_gaps.length > 0 ? (
              <span style={{ fontSize: tokens.fontSize.sm, color: tonePalette.warning.fg }}>Not runnable: {s.policy_gaps.map(words).join(", ")}</span>
            ) : (
              <span style={{ fontSize: tokens.fontSize.sm, color: tonePalette.success.fg }}>Permission policy satisfied until {day(s.terms_review_due_at)}</span>
            )}
            {(s.status === "active" || s.status === "paused") && (
              <Button size="sm" loading={busy} onClick={() => void toggle(s)}>
                {s.status === "active" ? "Pause" : "Resume"}
              </Button>
            )}
            {error && <span style={{ fontSize: tokens.fontSize.sm, color: tonePalette.danger.fg }}>{error}</span>}
          </div>
          {s.kind === "apify_actor" && <ApifySourcePanel id={s.id} active={s.status === "active"} minIntervalMinutes={s.min_interval_minutes} maxDailyUsd={s.max_daily_usd} onChange={() => {
            detail.reload();
            onChange();
          }} />}
          {s.status !== "rejected" && (
            <Card title={s.status === "proposed" ? "Review this source" : "Re-review"} subtitle="A source runs only with a permission basis, a robots/terms assessment and an unexpired review.">
              <ReviewForm s={s} onDone={() => {
                detail.reload();
                onChange();
              }} />
            </Card>
          )}
          <Card title="Review history" flush>
            <DataTable
              columns={[
                { key: "when", header: "Date", render: (r) => day(r.created_at) },
                { key: "decision", header: "Decision", render: (r) => <Badge tone={r.decision === "approved" ? "success" : "danger"}>{r.decision}</Badge> },
                { key: "basis", header: "Basis", render: (r) => words(r.permission_basis) },
                { key: "due", header: "Valid until", render: (r) => day(r.terms_review_due_at) },
                { key: "by", header: "By", render: (r) => r.reviewer_label ?? "staff" },
                { key: "notes", header: "Notes", render: (r) => <span style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkMuted }}>{r.notes ?? ""}</span> },
              ]}
              rows={s.reviews}
              getRowKey={(r) => r.id}
              empty={<EmptyState compact title="Never reviewed" />}
            />
          </Card>
          <Card title="Recent runs" flush>
            <DataTable
              columns={[
                { key: "when", header: "When (UTC)", render: (r) => r.created_at.slice(0, 16).replace("T", " ") },
                { key: "query", header: "Query", render: (r) => <span style={{ fontSize: tokens.fontSize.xs }}>{r.query}</span> },
                { key: "results", header: "Results", align: "right", render: (r) => <span style={num}>{r.results}</span> },
                { key: "new", header: "New", align: "right", render: (r) => <span style={num}>{r.new_results}</span> },
                { key: "leads", header: "Leads", align: "right", render: (r) => <span style={num}>{r.leads}</span> },
                { key: "cost", header: "Cost", align: "right", render: (r) => <span style={num}>${r.cost_usd.toFixed(3)}</span> },
                { key: "error", header: "Error", render: (r) => (r.error ? <span style={{ fontSize: tokens.fontSize.xs, color: tonePalette.danger.fg }}>{r.error.slice(0, 80)}</span> : null) },
              ]}
              rows={s.runs}
              getRowKey={(r) => r.id}
              empty={<EmptyState compact title="No runs yet" description="Runs appear once the source is active and its queries come up in the rotation." />}
            />
          </Card>
        </div>
      )}
    </AsyncView>
  );
}

function ImportCard({ onDone }: { onDone: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SourceImport | null>(null);

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
      setResult(await api.importSources(document));
      onDone();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Import failed.");
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  return (
    <Card
      title="Add sources"
      subtitle="Import an agent's JSON report. Each source is screened on arrival; the ones that pass wait under Needs review."
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
      {error && <span style={{ color: tonePalette.danger.fg, fontSize: tokens.fontSize.sm }}>{error}</span>}
      {result && (
        <span style={{ fontSize: tokens.fontSize.sm }}>
          Read {result.received}: {result.added_proposed} waiting for review, {result.added_paused} held by screening, {result.already_known} already known, {result.rejected} rejected.
        </span>
      )}
      {!error && !result && <span style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkSubtle }}>Agents can also POST to /v1/sources with the x-intel-sources-token header.</span>}
    </Card>
  );
}

export default function SourcesPage() {
  const sources = useAsync(() => api.listSources(), []);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkNotice, setBulkNotice] = useState<{ text: string; tone: Tone }[] | null>(null);
  const toggle = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const columns: Column<RegistrySource>[] = [
    { key: "sweep", header: "In sweeps", render: (s) => <SweepToggle s={s} onChange={sources.reload} /> },
    {
      key: "source",
      header: "Source",
      render: (s) => (
        <div style={{ maxWidth: "36ch" }}>
          <div style={{ fontWeight: tokens.weight.medium }}>{s.name}</div>
          <div style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}>
            {s.domain} · {words(s.kind)} · {s.orientation} · {s.origin}
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (s) => (
        <div>
          <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
          {s.status_reason && <div style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs, marginTop: 2, maxWidth: "26ch" }}>{words(s.status_reason)}</div>}
        </div>
      ),
    },
    { key: "basis", header: "Permission", render: (s) => <span style={{ fontSize: tokens.fontSize.xs }}>{words(s.permission_basis)}</span> },
    { key: "due", header: "Review until", render: (s) => <span style={{ fontSize: tokens.fontSize.xs, color: s.policy_gaps.includes("terms_review_expired") ? tonePalette.danger.fg : undefined }}>{day(s.terms_review_due_at)}</span> },
    { key: "health", header: "Health", render: (s) => <Badge tone={HEALTH_TONE[s.health]}>{s.health}</Badge> },
    { key: "searches", header: "Runs 30d", align: "right", render: (s) => <span style={num}>{s.yield?.searches ?? 0}</span> },
    { key: "leads", header: "Leads", align: "right", render: (s) => <span style={num}>{s.yield?.leads ?? 0}</span> },
    { key: "actionable", header: "Actionable", align: "right", render: (s) => <span style={{ ...num, fontWeight: (s.yield?.actionable ?? 0) > 0 ? 600 : 400 }}>{s.yield?.actionable ?? 0}</span> },
    { key: "cost", header: "Cost 30d", align: "right", render: (s) => <span style={num}>${(s.yield?.costUsd ?? 0).toFixed(2)}</span> },
    {
      key: "open",
      header: "",
      align: "right",
      render: (s) => (
        <Button size="sm" variant={open === s.id ? "secondary" : s.status === "proposed" ? "primary" : "ghost"} onClick={() => setOpen(open === s.id ? null : s.id)}>
          {open === s.id ? "Close" : s.status === "proposed" ? "Review" : "Details"}
        </Button>
      ),
    },
  ];

  return (
    <div className="oos-stack" style={{ gap: tokens.space.xl }}>
      <PageHeader
        eyebrow="Opportunity intelligence"
        title="Source Registry"
        subtitle="Every place discovery reads from: search venues, official-API connectors and Apify actors. A source runs only once its permission policy is reviewed, and pauses itself when it fails or never yields."
      />
      <ImportCard onDone={sources.reload} />
      <RegisterApifySource onDone={sources.reload} />
      <QuarantineCard />
      <AsyncView state={sources} loadingLabel="Loading sources">
        {(rows) => {
          const counts = Object.fromEntries(FILTERS.map((f) => [f, rows.filter((s) => matches(s, f)).length]));
          const shown = rows.filter((s) => matches(s, filter));
          const selected = open ? rows.find((s) => s.id === open) : undefined;
          // Only rows still eligible count, so a reload after approval drops them from the selection.
          const bulk = rows.filter((s) => picked.has(s.id) && bulkReviewable(s));
          const pickable = shown.filter(bulkReviewable);
          const allPicked = pickable.length > 0 && pickable.every((s) => picked.has(s.id));
          const pickColumn: Column<RegistrySource> = {
            key: "pick",
            header: (
              <input
                type="checkbox"
                aria-label="Select every reviewable search venue shown"
                title="Select every proposed or paused search venue shown"
                checked={allPicked}
                disabled={pickable.length === 0}
                onChange={(e) => toggle(pickable.map((s) => s.id), e.target.checked)}
              />
            ),
            render: (s) =>
              bulkReviewable(s) ? <input type="checkbox" aria-label={`Select ${s.name} (${s.orientation})`} checked={picked.has(s.id)} onChange={(e) => toggle([s.id], e.target.checked)} /> : null,
          };
          return (
            <>
              <div style={{ display: "flex", gap: tokens.space.xs, flexWrap: "wrap" }} role="group" aria-label="Filter">
                {FILTERS.map((f) => (
                  <Button key={f} size="sm" variant={f === filter ? "primary" : "secondary"} aria-pressed={f === filter} onClick={() => setFilter(f)}>
                    {f} ({counts[f]})
                  </Button>
                ))}
              </div>
              {bulkNotice && (
                <div className="oos-stack" style={{ gap: tokens.space.xs, fontSize: tokens.fontSize.sm }} role="status">
                  {bulkNotice.map((n) => (
                    <span key={n.text} style={{ color: tonePalette[n.tone].fg }}>
                      {n.text}
                    </span>
                  ))}
                </div>
              )}
              {bulk.length > 0 && <BulkApprove selected={bulk} onClear={() => setPicked(new Set())} onDone={(ids, summary) => {
                toggle(ids, false);
                setBulkNotice(summary);
                sources.reload();
              }} />}
              <Card flush title={`${shown.length} sources`}>
                <DataTable columns={[pickColumn, ...columns]} rows={shown} getRowKey={(s) => s.id} empty={<EmptyState compact title="Nothing here" description="No source matches this filter." />} />
              </Card>
              {selected && (
                <Card title={selected.name} subtitle={`${selected.domain} · ${selected.topics.length ? `searched for: ${selected.topics.join(" · ")}` : words(selected.kind)}`}>
                  <SourceDetail id={selected.id} onChange={sources.reload} />
                </Card>
              )}
            </>
          );
        }}
      </AsyncView>
    </div>
  );
}
