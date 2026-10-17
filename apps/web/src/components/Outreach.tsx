"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, Field, Input, Select, Textarea, tokens, type Tone } from "@opportunity-os/ui";
import { api, type ConversationMessage, type PartyDetail } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { words } from "./Contacts";

/** Email outreach (ADR-045): compose, edit, approve. Nothing is sent without "Approve and send". */

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export const MESSAGE_TONE: Record<string, Tone> = {
  draft: "neutral",
  queued: "progress",
  sending: "progress",
  sent: "success",
  failed: "danger",
  cancelled: "neutral",
  received: "info",
};
export const CLASS_TONE: Record<string, Tone> = { reply: "info", opt_out: "danger", bounce: "danger", auto_reply: "neutral" };

const BLOCK_TEXT: Record<string, string> = {
  no_consent_recorded: "No consent recorded for email. Record the basis in the Consent card first.",
  consent_opted_out: "This contact opted out of email.",
  consent_denied: "This contact declined email.",
  address_bounced: "This address bounced.",
  address_invalid: "This address is marked invalid.",
  address_suppressed: "This address is on the suppression list.",
  invalid_address: "Not a valid email address.",
};
export const blockText = (reason: string) => BLOCK_TEXT[reason] ?? words(reason);

/** One outbound message: edit while a draft, approve or cancel; status afterwards. */
export function MessageEditor({ m, onChange }: { m: ConversationMessage; onChange: () => void }) {
  const [subject, setSubject] = useState(m.subject);
  const [body, setBody] = useState(m.body_text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = subject !== m.subject || body !== m.body_text;

  async function act(fn: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(errorText(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  if (m.status !== "draft") {
    return (
      <div className="oos-stack" style={{ gap: tokens.space.xs }}>
        <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap", fontSize: tokens.fontSize.sm }}>
          <Badge tone={MESSAGE_TONE[m.status]}>{m.status}</Badge>
          <span>to {m.to_address}</span>
          <span style={{ color: tokens.color.inkMuted }}>{m.sent_at ? `sent ${when(m.sent_at)}` : m.queued_at ? `approved ${when(m.queued_at)}` : when(m.created_at)}</span>
          {m.status === "queued" && (
            <Button size="sm" variant="ghost" loading={busy} onClick={() => void act(() => api.cancelMessage(m.id), "Could not cancel")}>
              Cancel
            </Button>
          )}
        </div>
        {m.error && <div style={{ fontSize: tokens.fontSize.xs, color: "#b02525" }}>{words(m.error)}</div>}
        <div style={{ fontWeight: 600, fontSize: tokens.fontSize.sm }}>{m.subject}</div>
        <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: tokens.fontSize.sm, margin: 0 }}>{m.body_text}</pre>
        {error && <div style={{ fontSize: tokens.fontSize.xs, color: "#b02525" }}>{error}</div>}
      </div>
    );
  }

  return (
    <div className="oos-stack" style={{ gap: tokens.space.sm }}>
      <div style={{ fontSize: tokens.fontSize.sm }}>
        <Badge tone="neutral">draft</Badge> to <strong>{m.to_address}</strong>
      </div>
      <Field label="Subject" htmlFor={`subj-${m.id}`}>
        <Input id={`subj-${m.id}`} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
      </Field>
      <Field label="Message" htmlFor={`body-${m.id}`}>
        <Textarea id={`body-${m.id}`} value={body} onChange={(e) => setBody(e.target.value)} rows={8} />
      </Field>
      <div style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkMuted }}>Your name, postal address and an unsubscribe link are added below the message when it is sent.</div>
      <div style={{ display: "flex", gap: tokens.space.sm, flexWrap: "wrap" }}>
        {dirty ? (
          <Button size="sm" variant="primary" loading={busy} disabled={!subject.trim() || !body.trim()} onClick={() => void act(() => api.editDraft(m.id, { subject, body }), "Could not save")}>
            Save draft
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            onClick={() =>
              void act(async () => {
                // Approve exactly what is on screen: the server refuses if the draft changed since.
                const current = await api.outreachMessage(m.id);
                if (current.subject !== m.subject || current.body_text !== m.body_text) throw new Error("The draft changed since you opened it; reload and review it again");
                if (!window.confirm(`Send this email to ${m.to_address}?`)) return;
                await api.approveMessage(m.id, current.current_hash);
              }, "Could not approve")
            }
          >
            Approve and send
          </Button>
        )}
        <Button size="sm" variant="ghost" loading={busy} onClick={() => void act(() => api.cancelMessage(m.id), "Could not discard")}>
          Discard
        </Button>
      </div>
      {error && <div style={{ fontSize: tokens.fontSize.xs, color: "#b02525" }}>{error}</div>}
    </div>
  );
}

/** Email card on a contact page: their conversations and a new email. */
export function ContactEmail({ d }: { d: PartyDetail }) {
  const emails = d.channels.filter((c) => c.kind === "email");
  const [to, setTo] = useState(emails.find((c) => c.is_primary)?.value ?? emails[0]?.value ?? "");
  const [composing, setComposing] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const deals = d.links.filter((l) => l.subject_type === "intel_candidate" || l.subject_type === "opportunity");
  const [deal, setDeal] = useState(deals[0] ? `${deals[0].subject_type}:${deals[0].subject_id}` : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = useAsync(() => api.partyOutreach(d.party.id, to || undefined), [d.party.id, to]);
  const status = useAsync(() => api.outreachStatus(), []);
  const blocked = state.data?.blocked ?? null;

  return (
    <Card title="Email" subtitle="Approval-first: a draft is sent only after you approve it.">
      <div className="oos-stack" style={{ gap: tokens.space.sm }}>
        {status.data && !status.data.configured && (
          <div style={{ fontSize: tokens.fontSize.sm, color: "#8a5a00" }}>Sending is not set up yet (missing {status.data.missing.join(", ")}). Drafts can still be written.</div>
        )}
        {(state.data?.conversations ?? []).map((c) => (
          <div key={c.id} style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap", fontSize: tokens.fontSize.sm, borderBottom: `1px solid ${tokens.color.border}`, padding: `${tokens.space.xs}px 0` }}>
            <Link className="oos-link" href={`/outreach/${c.id}`}>
              {c.subject}
            </Link>
            <span style={{ color: tokens.color.inkMuted }}>{c.their_address}</span>
            {c.status === "closed" && <Badge tone="neutral">closed</Badge>}
            {c.last_inbound_at && (!c.last_outbound_at || c.last_inbound_at > c.last_outbound_at) ? <Badge tone="info">replied</Badge> : c.last_outbound_at ? <Badge tone="progress">awaiting reply</Badge> : <Badge tone="neutral">draft</Badge>}
          </div>
        ))}
        {emails.length === 0 ? (
          <div style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>Add an email channel to write to this contact.</div>
        ) : !composing ? (
          <div>
            <Button size="sm" onClick={() => setComposing(true)}>
              New email
            </Button>
          </div>
        ) : (
          <div className="oos-stack" style={{ gap: tokens.space.sm }}>
            <Field label="To" htmlFor="out-to">
              <Select id="out-to" value={to} onChange={(e) => setTo(e.target.value)}>
                {emails.map((c) => (
                  <option key={c.id} value={c.value}>
                    {c.value}
                    {c.status !== "active" ? ` (${c.status})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            {blocked && <div style={{ fontSize: tokens.fontSize.sm, color: "#b02525" }}>{blockText(blocked)} You can save a draft, but it cannot be approved.</div>}
            {deals.length > 0 && (
              <Field label="About" htmlFor="out-deal">
                <Select id="out-deal" value={deal} onChange={(e) => setDeal(e.target.value)}>
                  <option value="">No specific deal</option>
                  {deals.map((l) => (
                    <option key={l.id} value={`${l.subject_type}:${l.subject_id}`}>
                      {words(l.subject_type)} · {words(l.role)} · {l.subject_id.slice(0, 8)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Subject" htmlFor="out-subject">
              <Input id="out-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
            </Field>
            <Field label="Message" htmlFor="out-body">
              <Textarea id="out-body" value={body} onChange={(e) => setBody(e.target.value)} rows={8} placeholder="Say who you are and why you are writing. No made-up familiarity." />
            </Field>
            <div style={{ display: "flex", gap: tokens.space.sm }}>
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                disabled={!subject.trim() || !body.trim() || !to}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const [subjectType, subjectId] = deal ? (deal.split(":") as ["intel_candidate" | "opportunity", string]) : [null, null];
                    const out = await api.createDraft({ partyId: d.party.id, toAddress: to, subject, body, subjectType, subjectId });
                    window.location.href = `/outreach/${out.conversationId}`;
                  } catch (err) {
                    setError(errorText(err, "Could not save the draft"));
                    setBusy(false);
                  }
                }}
              >
                Save draft and review
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setComposing(false)}>
                Cancel
              </Button>
            </div>
            {error && <div style={{ fontSize: tokens.fontSize.xs, color: "#b02525" }}>{error}</div>}
          </div>
        )}
      </div>
    </Card>
  );
}
