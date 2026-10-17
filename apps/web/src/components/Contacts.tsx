"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, Button, Field, Input, Select, tokens, type Tone } from "@opportunity-os/ui";
import { api, ApiError, type ChannelInput, type ContactChannel, type CreatePartyInput, type LinkRole, type LinkSubject, type PartyType, type SubjectParty } from "../lib/api";
import { useAsync } from "../lib/useAsync";

export const words = (s: string | null | undefined) => (s ?? "").replaceAll("_", " ");

export const CONSENT_TONE: Record<string, Tone> = { granted: "success", denied: "danger", opted_out: "danger", none: "neutral" };
export const ROLES: LinkRole[] = ["seller", "buyer", "provider", "decision_maker", "other"];

/** A channel as text, with a link where it is one. */
export function ChannelValue({ ch }: { ch: Pick<ContactChannel, "kind" | "value" | "status"> }) {
  const struck = ch.status !== "active" ? { textDecoration: "line-through", color: tokens.color.inkSubtle } : undefined;
  if (ch.kind === "email") return <a href={`mailto:${ch.value}`} className="oos-link" style={struck}>{ch.value}</a>;
  if (ch.kind === "phone") return <a href={`tel:${ch.value.replace(/[^\d+]/g, "")}`} className="oos-link" style={struck}>{ch.value}</a>;
  if (ch.kind === "website" || ch.kind === "marketplace_profile" || ch.kind === "social") {
    const href = /^https?:\/\//i.test(ch.value) ? ch.value : `https://${ch.value}`;
    return <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="oos-link" style={struck}>{ch.value}</a>;
  }
  return <span style={struck}>{ch.value}</span>;
}

export interface ContactFormDefaults {
  type?: PartyType;
  displayName?: string;
  email?: string;
  phone?: string;
  website?: string;
  role?: LinkRole;
  sourceType?: CreatePartyInput["sourceType"];
  sourceUrl?: string | null;
}

/**
 * New contact or organization, optionally linked to a lead, candidate or deal.
 * When an email or phone already belongs to someone, offers that contact
 * instead of creating a duplicate.
 */
export function ContactForm({ defaults, link, onDone, onCancel }: { defaults?: ContactFormDefaults; link?: { subjectType: LinkSubject; subjectId: string }; onDone: (id: string) => void; onCancel?: () => void }) {
  const [type, setType] = useState<PartyType>(defaults?.type ?? "person");
  const [name, setName] = useState(defaults?.displayName ?? "");
  const [roleTitle, setRoleTitle] = useState("");
  const [email, setEmail] = useState(defaults?.email ?? "");
  const [phone, setPhone] = useState(defaults?.phone ?? "");
  const [website, setWebsite] = useState(defaults?.website ?? "");
  const [role, setRole] = useState<LinkRole>(defaults?.role ?? "seller");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: string; name: string } | null>(null);

  const body = (): CreatePartyInput => {
    const channels: ChannelInput[] = [];
    const sourceLabel = defaults?.sourceUrl ? ("source_fact" as const) : undefined;
    if (email.trim()) channels.push({ kind: "email", value: email.trim(), isPrimary: true, sourceLabel, sourceUrl: defaults?.sourceUrl ?? null });
    if (phone.trim()) channels.push({ kind: "phone", value: phone.trim(), isPrimary: true, sourceLabel, sourceUrl: defaults?.sourceUrl ?? null });
    return {
      type,
      displayName: name.trim(),
      roleTitle: type === "person" ? roleTitle.trim() || null : null,
      website: website.trim() || null,
      sourceType: defaults?.sourceType ?? "operator",
      sourceUrl: defaults?.sourceUrl ?? null,
      channels,
      ...(link ? { link: { ...link, role } } : {}),
    };
  };

  async function submit(allowDuplicate = false) {
    setBusy(true);
    setError(null);
    setDuplicate(null);
    try {
      const created = await api.createParty(body(), allowDuplicate);
      onDone(created.party.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const found = (await api.listParties({ q: email.trim() || phone.trim() }).catch(() => []))[0];
        if (found) setDuplicate({ id: found.id, name: found.display_name });
      }
      setError(err instanceof Error ? err.message : "Could not save the contact");
    } finally {
      setBusy(false);
    }
  }

  async function useExisting() {
    if (!duplicate || !link) return;
    setBusy(true);
    try {
      await api.linkParty(duplicate.id, { ...link, role });
      onDone(duplicate.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link the contact");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="oos-stack" style={{ gap: tokens.space.md }}>
      <div style={{ display: "grid", gap: tokens.space.md, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <Field label="Kind" htmlFor="cf-type">
          <Select id="cf-type" value={type} onChange={(e) => setType(e.target.value as PartyType)}>
            <option value="person">Person</option>
            <option value="organization">Organization</option>
          </Select>
        </Field>
        <Field label="Name" htmlFor="cf-name" required>
          <Input id="cf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={type === "person" ? "Jo Rivera" : "Acme Surplus LLC"} />
        </Field>
        {type === "person" && (
          <Field label="Title" htmlFor="cf-title">
            <Input id="cf-title" value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} placeholder="Purchasing manager" />
          </Field>
        )}
        {link && (
          <Field label="Role in this deal" htmlFor="cf-role">
            <Select id="cf-role" value={role} onChange={(e) => setRole(e.target.value as LinkRole)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {words(r)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Email" htmlFor="cf-email">
          <Input id="cf-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Phone" htmlFor="cf-phone">
          <Input id="cf-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Website" htmlFor="cf-web">
          <Input id="cf-web" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="acme.com" />
        </Field>
      </div>
      <div style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>
        Saving a contact records no consent to message them. Record consent on the contact before any outreach.
      </div>
      <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap" }}>
        <Button size="sm" loading={busy} disabled={!name.trim()} onClick={() => void submit()}>
          Save contact
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {error && <span style={{ fontSize: tokens.fontSize.xs, color: "#b02525" }}>{error}</span>}
      </div>
      {duplicate && (
        <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap", fontSize: tokens.fontSize.sm }}>
          <span>
            Already saved as <Link href={`/relationships/${duplicate.id}`} className="oos-link">{duplicate.name}</Link>.
          </span>
          {link && (
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void useExisting()}>
              Link {duplicate.name} instead
            </Button>
          )}
          <Button size="sm" variant="ghost" loading={busy} onClick={() => void submit(true)}>
            Save as a separate contact
          </Button>
        </div>
      )}
    </div>
  );
}

function outreachBadge(p: SubjectParty) {
  // The subject list carries no consent detail; the contact page shows it in full.
  return p.channels.some((c) => c.status === "active" && (c.kind === "email" || c.kind === "phone")) ? null : <Badge tone="warning">no email or phone</Badge>;
}

/** The contacts on a candidate, and adding one (prefilled from the contact path the model found). */
export function SubjectContacts({ subjectType, subjectId, defaults, onChange }: { subjectType: LinkSubject; subjectId: string; defaults?: ContactFormDefaults; onChange?: () => void }) {
  const parties = useAsync(() => api.subjectParties(subjectType, subjectId), [subjectType, subjectId]);
  const [adding, setAdding] = useState(false);
  return (
    <div className="oos-stack" style={{ gap: tokens.space.sm }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: tokens.space.sm }}>
        <div style={{ fontSize: tokens.fontSize.xs, fontWeight: tokens.weight.semibold, color: tokens.color.inkSubtle, textTransform: "uppercase", letterSpacing: "0.04em" }}>Contacts</div>
        {!adding && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            Add contact
          </Button>
        )}
      </div>
      {parties.error && <div style={{ fontSize: tokens.fontSize.xs, color: "#b02525" }}>{parties.error}</div>}
      {parties.data && parties.data.length === 0 && !adding && <div style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkSubtle }}>No contacts saved for this deal yet.</div>}
      {parties.data?.map((p) => (
        <div key={p.link_id} style={{ fontSize: tokens.fontSize.sm, display: "flex", gap: tokens.space.sm, flexWrap: "wrap", alignItems: "baseline" }}>
          <Link href={`/relationships/${p.id}`} className="oos-link" style={{ fontWeight: tokens.weight.medium }}>
            {p.display_name}
          </Link>
          <Badge tone="info">{words(p.role)}</Badge>
          {p.role_title && <span style={{ color: tokens.color.inkMuted }}>{p.role_title}</span>}
          {p.organization_name && <span style={{ color: tokens.color.inkMuted }}>at {p.organization_name}</span>}
          {p.channels
            .filter((c) => c.kind === "email" || c.kind === "phone")
            .slice(0, 3)
            .map((c) => (
              <ChannelValue key={c.id} ch={c} />
            ))}
          {outreachBadge(p)}
        </div>
      ))}
      {adding && (
        <ContactForm
          defaults={defaults}
          link={{ subjectType, subjectId }}
          onCancel={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            parties.reload();
            onChange?.();
          }}
        />
      )}
    </div>
  );
}
