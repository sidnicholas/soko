"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Field, Input, PageHeader, Select, Textarea, tokens } from "@opportunity-os/ui";
import {
  api,
  type ChannelKind,
  type ConsentBasis,
  type ConsentChannel,
  type ConsentPurpose,
  type ConsentStatus,
  type MemoryInput,
  type MemoryKind,
  type MemoryLabel,
  type PartyDetail,
  type RelationshipMemory,
} from "../../../lib/api";
import { useAsync } from "../../../lib/useAsync";
import { AsyncView } from "../../../components/AsyncView";
import { CONSENT_TONE, ChannelValue, words } from "../../../components/Contacts";
import { ContactEmail } from "../../../components/Outreach";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);
const CHANNEL_KINDS: ChannelKind[] = ["email", "phone", "website", "marketplace_profile", "social", "address", "other"];
const MEMORY_KINDS: MemoryKind[] = ["fact", "preference", "commitment", "objection", "red_flag", "buying_cycle", "outcome", "note"];
const MEMORY_LABELS: MemoryLabel[] = ["source_fact", "inference", "estimate", "unknown"];
const BASES: { value: ConsentBasis; label: string }[] = [
  { value: "explicit", label: "They said yes (explicit)" },
  { value: "existing_relationship", label: "Existing business relationship" },
  { value: "public_business_contact", label: "Published business contact" },
  { value: "none", label: "None" },
];

/** Runs one change, then reloads; shows the error inline. */
function useAction(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>, fallback = "Could not save") {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
      return true;
    } catch (err) {
      setError(errorText(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function ErrorLine({ text }: { text: string | null }) {
  return text ? <div style={{ fontSize: tokens.fontSize.xs, color: "#b02525" }}>{text}</div> : null;
}

function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap", padding: `${tokens.space.xs}px 0`, borderBottom: `1px solid ${tokens.color.border}`, fontSize: tokens.fontSize.sm }}>{children}</div>;
}

function Details({ d, reload }: { d: PartyDetail; reload: () => void }) {
  const p = d.party;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.display_name);
  const [title, setTitle] = useState(p.role_title ?? "");
  const [website, setWebsite] = useState(p.website ?? "");
  const [location, setLocation] = useState(p.location ?? "");
  const [orgQuery, setOrgQuery] = useState(p.organization_name ?? "");
  const orgs = useAsync(() => (editing && p.type === "person" ? api.listParties({ type: "organization" }) : Promise.resolve([])), [editing, p.type]);
  const [orgId, setOrgId] = useState<string>(p.organization_id ?? "");
  const a = useAction(reload);

  if (!editing) {
    return (
      <Card
        title="Details"
        actions={
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
        }
      >
        <div style={{ display: "grid", gap: tokens.space.md, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", fontSize: tokens.fontSize.sm }}>
          {p.type === "person" && <Field label="Title">{p.role_title ?? "—"}</Field>}
          {p.type === "person" && (
            <Field label="Organization">{p.organization_id ? <Link href={`/relationships/${p.organization_id}`} className="oos-link">{p.organization_name}</Link> : "—"}</Field>
          )}
          <Field label="Website">{p.website ?? "—"}</Field>
          <Field label="Location">{p.location ?? "—"}</Field>
          <Field label="Source">
            {words(p.source_type) || "—"}
            {p.source_url && (
              <>
                {" · "}
                <a href={p.source_url} target="_blank" rel="noopener noreferrer nofollow" className="oos-link">
                  page
                </a>
              </>
            )}
          </Field>
          <Field label="Added">{day(p.created_at)}</Field>
        </div>
      </Card>
    );
  }
  return (
    <Card title="Edit details">
      <div style={{ display: "grid", gap: tokens.space.md, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <Field label="Name" htmlFor="ed-name">
          <Input id="ed-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {p.type === "person" && (
          <Field label="Title" htmlFor="ed-title">
            <Input id="ed-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
        )}
        {p.type === "person" && (
          <Field label="Organization" htmlFor="ed-org" hint="Create the organization as its own contact first.">
            <Input id="ed-org-q" aria-label="Filter organizations" placeholder="Filter" value={orgQuery} onChange={(e) => setOrgQuery(e.target.value)} />
            <Select id="ed-org" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              <option value="">None</option>
              {(orgs.data ?? [])
                .filter((o) => o.id === orgId || o.display_name.toLowerCase().includes(orgQuery.toLowerCase()))
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.display_name}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field label="Website" htmlFor="ed-web">
          <Input id="ed-web" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </Field>
        <Field label="Location" htmlFor="ed-loc">
          <Input id="ed-loc" value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
      </div>
      <div style={{ display: "flex", gap: tokens.space.sm, marginTop: tokens.space.md }}>
        <Button
          size="sm"
          loading={a.busy}
          disabled={!name.trim()}
          onClick={async () => {
            const ok = await a.run(() =>
              api.updateParty(p.id, {
                displayName: name.trim(),
                website: website.trim() || null,
                location: location.trim() || null,
                ...(p.type === "person" ? { roleTitle: title.trim() || null, organizationId: orgId || null } : {}),
              }),
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
      <ErrorLine text={a.error} />
    </Card>
  );
}

function Channels({ d, reload }: { d: PartyDetail; reload: () => void }) {
  const [kind, setKind] = useState<ChannelKind>("email");
  const [value, setValue] = useState("");
  const a = useAction(reload);
  return (
    <Card title="How to reach them" subtitle="Mark a channel invalid or bounced when it stops working; the freshness check uses websites and email domains.">
      {d.channels.length === 0 && <div style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkSubtle }}>No channels yet.</div>}
      {d.channels.map((ch) => (
        <Row key={ch.id}>
          <Badge tone="neutral">{words(ch.kind)}</Badge>
          <ChannelValue ch={ch} />
          {ch.is_primary && <Badge tone="info">primary</Badge>}
          {ch.status !== "active" && <Badge tone="danger">{ch.status}</Badge>}
          <span style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}>
            {words(ch.source_label)}
            {ch.verified_at ? ` · verified ${day(ch.verified_at)}` : ""}
          </span>
          <span style={{ flex: 1 }} />
          {ch.status === "active" ? (
            <>
              <Button size="sm" variant="ghost" disabled={a.busy} onClick={() => void a.run(() => api.setChannelStatus(d.party.id, ch.id, "active"))}>
                Verified
              </Button>
              <Button size="sm" variant="ghost" disabled={a.busy} onClick={() => void a.run(() => api.setChannelStatus(d.party.id, ch.id, ch.kind === "email" ? "bounced" : "invalid"))}>
                {ch.kind === "email" ? "Bounced" : "Invalid"}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" disabled={a.busy} onClick={() => void a.run(() => api.setChannelStatus(d.party.id, ch.id, "active"))}>
              Works again
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={a.busy} onClick={() => void a.run(() => api.removeChannel(d.party.id, ch.id))}>
            Remove
          </Button>
        </Row>
      ))}
      <form
        style={{ display: "flex", gap: tokens.space.sm, flexWrap: "wrap", marginTop: tokens.space.md }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (await a.run(() => api.addChannel(d.party.id, { kind, value: value.trim() }))) setValue("");
        }}
      >
        <Select aria-label="Channel kind" value={kind} onChange={(e) => setKind(e.target.value as ChannelKind)} style={{ flex: "0 1 180px" }}>
          {CHANNEL_KINDS.map((k) => (
            <option key={k} value={k}>
              {words(k)}
            </option>
          ))}
        </Select>
        <Input aria-label="Value" value={value} onChange={(e) => setValue(e.target.value)} style={{ flex: "1 1 220px" }} />
        <Button size="sm" variant="secondary" type="submit" loading={a.busy} disabled={!value.trim()}>
          Add
        </Button>
      </form>
      <ErrorLine text={a.error} />
    </Card>
  );
}

function Consent({ d, reload }: { d: PartyDetail; reload: () => void }) {
  const [channelKind, setChannelKind] = useState<ConsentChannel>("email");
  const [purpose, setPurpose] = useState<ConsentPurpose>("outreach");
  const [status, setStatus] = useState<ConsentStatus>("granted");
  const [basis, setBasis] = useState<ConsentBasis>("explicit");
  const [evidence, setEvidence] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const a = useAction(reload);
  const needsEvidence = status === "granted";
  return (
    <Card title="Consent" subtitle="Nothing is assumed: with no record, outreach on that channel is blocked. An opt-out always wins, and the history is never edited.">
      <div style={{ display: "flex", gap: tokens.space.sm, flexWrap: "wrap", marginBottom: tokens.space.md }}>
        {d.outreach.map((o) => (
          <Badge key={o.channel_kind} tone={CONSENT_TONE[o.status] ?? "neutral"}>
            {o.channel_kind}: {o.status === "none" ? "no consent" : words(o.status)}
            {o.basis && o.status === "granted" ? ` (${words(o.basis)})` : ""}
          </Badge>
        ))}
      </div>
      <div style={{ display: "grid", gap: tokens.space.md, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        <Field label="Channel" htmlFor="cs-ch">
          <Select id="cs-ch" value={channelKind} onChange={(e) => setChannelKind(e.target.value as ConsentChannel)}>
            {(["email", "phone", "sms", "whatsapp", "any"] as const).map((k) => (
              <option key={k} value={k}>
                {k === "any" ? "every channel" : k}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="For" htmlFor="cs-p">
          <Select id="cs-p" value={purpose} onChange={(e) => setPurpose(e.target.value as ConsentPurpose)}>
            <option value="outreach">Outreach</option>
            <option value="call_recording">Recording calls</option>
            <option value="marketing">Marketing</option>
          </Select>
        </Field>
        <Field label="Decision" htmlFor="cs-s">
          <Select id="cs-s" value={status} onChange={(e) => setStatus(e.target.value as ConsentStatus)}>
            <option value="granted">Granted</option>
            <option value="denied">Declined</option>
            <option value="opted_out">Opted out</option>
          </Select>
        </Field>
        <Field label="Basis" htmlFor="cs-b">
          <Select id="cs-b" value={basis} onChange={(e) => setBasis(e.target.value as ConsentBasis)}>
            {BASES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div style={{ marginTop: tokens.space.md }}>
        <Field label={needsEvidence ? "Evidence (required for a grant)" : "Note"} htmlFor="cs-e" hint="Where it came from: the email, the call, the page.">
          <Textarea id="cs-e" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </Field>
      </div>
      <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap" }}>
        <Button
          size="sm"
          variant={status === "granted" ? "primary" : "danger"}
          loading={a.busy}
          disabled={needsEvidence && (!evidence.trim() || basis === "none")}
          onClick={async () => {
            if (await a.run(() => api.recordConsent(d.party.id, { channelKind, purpose, status, basis, evidence: evidence.trim() || null }))) setEvidence("");
          }}
        >
          Record
        </Button>
        {purpose === "call_recording" && status === "granted" && basis !== "explicit" && <span style={{ fontSize: tokens.fontSize.xs, color: "#b02525" }}>Recording calls needs explicit consent.</span>}
        <span style={{ flex: 1 }} />
        {d.consents.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? "Hide history" : `History (${d.consents.length})`}
          </Button>
        )}
      </div>
      <ErrorLine text={a.error} />
      {showHistory &&
        d.consents.map((c) => (
          <Row key={c.id}>
            <span style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}>{c.recorded_at.slice(0, 16).replace("T", " ")}</span>
            <Badge tone={CONSENT_TONE[c.status] ?? "neutral"}>{words(c.status)}</Badge>
            <span>
              {c.channel_kind === "any" ? "every channel" : c.channel_kind} · {words(c.purpose)} · {words(c.basis)}
            </span>
            {c.evidence && <span style={{ color: tokens.color.inkMuted }}>{c.evidence}</span>}
          </Row>
        ))}
    </Card>
  );
}

function MemoryForm({ initial, onSave, onCancel, busy }: { initial?: RelationshipMemory; onSave: (m: MemoryInput) => void; onCancel?: () => void; busy: boolean }) {
  const [kind, setKind] = useState<MemoryKind>(initial?.kind ?? "fact");
  const [content, setContent] = useState(initial?.content ?? "");
  const [label, setLabel] = useState<MemoryLabel>(initial?.source_label ?? "source_fact");
  const [confidence, setConfidence] = useState(String(initial?.confidence ?? 1));
  const [restricted, setRestricted] = useState(initial?.access === "restricted");
  return (
    <div className="oos-stack" style={{ gap: tokens.space.sm }}>
      <div style={{ display: "grid", gap: tokens.space.md, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <Field label="Kind" htmlFor="m-kind">
          <Select id="m-kind" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
            {MEMORY_KINDS.map((k) => (
              <option key={k} value={k}>
                {words(k)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="How it is known" htmlFor="m-label">
          <Select id="m-label" value={label} onChange={(e) => setLabel(e.target.value as MemoryLabel)}>
            {MEMORY_LABELS.map((k) => (
              <option key={k} value={k}>
                {words(k)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Confidence (0–1)" htmlFor="m-conf">
          <Input id="m-conf" type="number" min={0} max={1} step={0.1} value={confidence} onChange={(e) => setConfidence(e.target.value)} />
        </Field>
        <Field label="Access" htmlFor="m-access">
          <Select id="m-access" value={restricted ? "restricted" : "internal"} onChange={(e) => setRestricted(e.target.value === "restricted")}>
            <option value="internal">Internal</option>
            <option value="restricted">Restricted</option>
          </Select>
        </Field>
      </div>
      <Textarea aria-label="Memory" value={content} onChange={(e) => setContent(e.target.value)} placeholder="Buys pallets of returns every quarter; prefers phone before 10am." />
      <div style={{ display: "flex", gap: tokens.space.sm }}>
        <Button
          size="sm"
          loading={busy}
          disabled={!content.trim()}
          onClick={() => onSave({ kind, content: content.trim(), sourceType: "operator", sourceLabel: label, confidence: Math.min(1, Math.max(0, Number(confidence) || 0)), access: restricted ? "restricted" : "internal" })}
        >
          {initial ? "Save correction" : "Add memory"}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function Memories({ d, reload }: { d: PartyDetail; reload: () => void }) {
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const a = useAction(reload);
  return (
    <Card
      title="What we know"
      subtitle="Each memory keeps its source and confidence. A correction replaces it and keeps the old version; a deletion removes the content."
      actions={
        !adding && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            Add memory
          </Button>
        )
      }
    >
      {adding && (
        <div style={{ marginBottom: tokens.space.md }}>
          <MemoryForm
            busy={a.busy}
            onCancel={() => setAdding(false)}
            onSave={async (m) => {
              if (await a.run(() => api.addMemory(d.party.id, m))) setAdding(false);
            }}
          />
        </div>
      )}
      {d.memories.length === 0 && !adding && <div style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkSubtle }}>Nothing recorded yet.</div>}
      {d.memories.map((m) =>
        correcting === m.id ? (
          <div key={m.id} style={{ padding: `${tokens.space.sm}px 0`, borderBottom: `1px solid ${tokens.color.border}` }}>
            <MemoryForm
              initial={m}
              busy={a.busy}
              onCancel={() => setCorrecting(null)}
              onSave={async (input) => {
                if (await a.run(() => api.correctMemory(d.party.id, m.id, input))) setCorrecting(null);
              }}
            />
          </div>
        ) : (
          <Row key={m.id}>
            <Badge tone={m.kind === "red_flag" || m.kind === "objection" ? "warning" : m.kind === "commitment" ? "accent" : "neutral"}>{words(m.kind)}</Badge>
            <span style={{ flex: "1 1 260px", whiteSpace: "pre-wrap" }}>{m.content}</span>
            <span style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}>
              {words(m.source_label)} · {Math.round(m.confidence * 100)}% · {words(m.source_type)} · {day(m.created_at)}
              {m.access === "restricted" ? " · restricted" : ""}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setCorrecting(m.id)}>
              Correct
            </Button>
            <Button size="sm" variant="ghost" disabled={a.busy} onClick={() => void a.run(() => api.deleteMemory(d.party.id, m.id))}>
              Delete
            </Button>
          </Row>
        ),
      )}
      <ErrorLine text={a.error} />
    </Card>
  );
}

function Links({ d, reload }: { d: PartyDetail; reload: () => void }) {
  const a = useAction(reload);
  if (d.links.length === 0 && d.members.length === 0) return null;
  return (
    <Card title={d.party.type === "organization" ? "Deals and people" : "Deals"}>
      {d.links.map((l) => (
        <Row key={l.id}>
          <Badge tone="info">{words(l.role)}</Badge>
          <span>
            {words(l.subject_type)}{" "}
            {l.subject_type === "intel_candidate" ? (
              <Link href="/queue" className="oos-link">
                {l.subject_id.slice(0, 8)}
              </Link>
            ) : l.subject_type === "opportunity" ? (
              <Link href={`/opportunities/${l.subject_id}`} className="oos-link">
                {l.subject_id.slice(0, 8)}
              </Link>
            ) : (
              l.subject_id.slice(0, 8)
            )}
          </span>
          <span style={{ color: tokens.color.inkSubtle, fontSize: tokens.fontSize.xs }}>since {day(l.created_at)}</span>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" disabled={a.busy} onClick={() => void a.run(() => api.unlinkParty(d.party.id, l.id))}>
            Unlink
          </Button>
        </Row>
      ))}
      {d.members.map((m) => (
        <Row key={m.id}>
          <Badge tone="neutral">person</Badge>
          <Link href={`/relationships/${m.id}`} className="oos-link">
            {m.display_name}
          </Link>
          {m.role_title && <span style={{ color: tokens.color.inkMuted }}>{m.role_title}</span>}
          {m.status === "archived" && <Badge tone="warning">archived</Badge>}
        </Row>
      ))}
      <ErrorLine text={a.error} />
    </Card>
  );
}

function Pipedrive({ d, reload }: { d: PartyDetail; reload: () => void }) {
  const a = useAction(reload);
  return (
    <Card title="Pipedrive" subtitle="Opportunity OS keeps the contact; Pipedrive gets a copy (name, organization, emails, phones), updated as it changes here.">
      <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap", fontSize: tokens.fontSize.sm }}>
        {d.crm?.external_url ? (
          <a href={d.crm.external_url} target="_blank" rel="noopener noreferrer" className="oos-link">
            Open in Pipedrive
          </a>
        ) : (
          <span style={{ color: tokens.color.inkSubtle }}>Not in Pipedrive yet. Contacts on a deal sent to Pipedrive are copied automatically.</span>
        )}
        <Button size="sm" variant="secondary" loading={a.busy} onClick={() => void a.run(() => api.syncPartyToPipedrive(d.party.id), "Could not reach Pipedrive")}>
          {d.crm?.external_url ? "Update copy" : "Copy to Pipedrive"}
        </Button>
      </div>
      <ErrorLine text={a.error} />
    </Card>
  );
}

function DangerZone({ d }: { d: PartyDetail }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card title="Delete this contact" subtitle="For a deletion request, or a contact entered by mistake. Removes everything here and the Pipedrive copy. The email and phone stay on a do-not-contact list as one-way hashes.">
      {!open ? (
        <Button size="sm" variant="danger" onClick={() => setOpen(true)}>
          Delete contact
        </Button>
      ) : (
        <div className="oos-stack" style={{ gap: tokens.space.sm }}>
          <Field label={`Type “${d.party.display_name}” to confirm`} htmlFor="del-confirm">
            <Input id="del-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <div style={{ display: "flex", gap: tokens.space.sm }}>
            <Button
              size="sm"
              variant="danger"
              loading={busy}
              disabled={confirm.trim().toLowerCase() !== d.party.display_name.trim().toLowerCase()}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const out = await api.deleteParty(d.party.id, confirm);
                  if (out.crm && !out.crm.deleted) window.alert(`Deleted here. The Pipedrive copy could not be deleted: ${out.crm.error ?? "Pipedrive not configured"}. Delete it in Pipedrive.`);
                  router.push("/relationships");
                } catch (err) {
                  setError(errorText(err, "Could not delete"));
                  setBusy(false);
                }
              }}
            >
              Delete permanently
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          <ErrorLine text={error} />
        </div>
      )}
    </Card>
  );
}

export default function PartyPage({ params }: { params: { id: string } }) {
  const state = useAsync(() => api.getParty(params.id), [params.id]);
  const a = useAction(state.reload);
  return (
    <AsyncView state={state} loadingLabel="Loading contact">
      {(d) => (
        <div className="oos-stack" style={{ gap: tokens.space.lg }}>
          <PageHeader
            eyebrow={
              <Link href="/relationships" className="oos-link">
                Relationships
              </Link>
            }
            title={d.party.display_name}
            subtitle={
              <span style={{ display: "inline-flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap" }}>
                <Badge tone={d.party.type === "organization" ? "accent" : "neutral"}>{d.party.type}</Badge>
                {d.party.status === "archived" ? (
                  <Badge tone="warning">archived {day(d.party.archived_at)} · next freshness check {day(d.party.freshness_due_at)}</Badge>
                ) : (
                  <span>last activity {day(d.party.last_activity_at)}</span>
                )}
              </span>
            }
            actions={
              d.party.status === "archived" && (
                <Button size="sm" loading={a.busy} onClick={() => void a.run(() => api.restoreParty(d.party.id))}>
                  Restore
                </Button>
              )
            }
          />
          <ErrorLine text={a.error} />
          <Details d={d} reload={state.reload} />
          <Channels d={d} reload={state.reload} />
          <Consent d={d} reload={state.reload} />
          <ContactEmail d={d} />
          <Memories d={d} reload={state.reload} />
          <Links d={d} reload={state.reload} />
          <Pipedrive d={d} reload={state.reload} />
          <DangerZone d={d} />
        </div>
      )}
    </AsyncView>
  );
}

