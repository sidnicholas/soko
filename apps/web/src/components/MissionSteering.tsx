"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { excludedTerms, type DemandSpecification } from "@opportunity-os/contracts";
import { Badge, Button, Card, EmptyState, Field, Input, Textarea, formatDateTime, formatScore, tokens } from "@opportunity-os/ui";
import { api, type RejectedOpportunity } from "../lib/api";
import type { AsyncState } from "../lib/useAsync";
import { AsyncView } from "./AsyncView";

function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" style={{ padding: tokens.space.sm, borderRadius: tokens.radius.md, background: "#fdecec", color: "#b02525", fontSize: tokens.fontSize.sm }}>
      {message}
    </div>
  );
}

export interface SteerAgentCardProps {
  missionId: string;
  spec: DemandSpecification | null;
  canEdit: boolean;
  /** Called after a successful steer so the page can refresh what it changed. */
  onSteered: () => void;
}

/**
 * Phase 4 user→agent steering: tell the agent what to stop matching. Each
 * submit records a new constraints version; discovery honors it on every
 * future cycle and matching open opportunities are set aside immediately.
 */
export function SteerAgentCard({ missionId, spec, canEdit, onSteered }: SteerAgentCardProps) {
  const [terms, setTerms] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const current = spec ? excludedTerms(spec) : [];

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const exclude = terms.split(",").map((t) => t.trim()).filter(Boolean);
    if (exclude.length === 0 && !note.trim()) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const { steering } = await api.steerMission(missionId, { exclude_terms: exclude, ...(note.trim() ? { note: note.trim() } : {}) });
      setTerms("");
      setNote("");
      const setAside = steering.rejectedOpportunityIds.length;
      setSaved(
        `Saved as constraints v${steering.versionNumber}` +
          (steering.addedTerms.length ? ` · now excluding ${steering.addedTerms.map((t) => `"${t}"`).join(", ")}` : "") +
          (setAside ? ` · ${setAside} opportunit${setAside === 1 ? "y" : "ies"} set aside` : ""),
      );
      onSteered();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not steer the agent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Steer the agent" subtitle="Tell discovery what to stop matching. Saved as a new constraints version.">
      <div className="oos-stack" style={{ gap: tokens.space.md }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: tokens.space.xs, alignItems: "center" }}>
          <span style={{ fontSize: tokens.fontSize.xs, textTransform: "uppercase", letterSpacing: "0.04em", color: tokens.color.inkSubtle }}>Excluding</span>
          {current.length === 0 ? (
            <span style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>Nothing yet</span>
          ) : (
            current.map((t) => (
              <Badge key={t} tone="danger" dot={false}>
                {t}
              </Badge>
            ))
          )}
        </div>
        {canEdit ? (
          <form onSubmit={onSubmit} className="oos-stack" style={{ gap: tokens.space.sm }}>
            <Field label="Exclude terms" htmlFor="steer-terms" hint="Comma-separated. Matched against listing titles and descriptions.">
              <Input id="steer-terms" value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="refurbished, open box" />
            </Field>
            <Field label="Note for the record" htmlFor="steer-note">
              <Textarea id="steer-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why — e.g. new only, warranty required" />
            </Field>
            <div>
              <Button type="submit" variant="primary" loading={busy} disabled={!terms.trim() && !note.trim()}>
                Steer
              </Button>
            </div>
            <ErrorNote message={error} />
            {saved && (
              <div role="status" style={{ padding: tokens.space.sm, borderRadius: tokens.radius.md, background: "#e8f6ee", color: "#1d6b3f", fontSize: tokens.fontSize.sm }}>
                {saved}
              </div>
            )}
          </form>
        ) : (
          <p style={{ margin: 0, fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>Viewers can't steer this mission.</p>
        )}
      </div>
    </Card>
  );
}

/** Opportunities set aside for this mission — by a person or by steering — with why. */
export function RejectedAlternativesCard({ state }: { state: AsyncState<RejectedOpportunity[]> }) {
  return (
    <Card title="Rejected alternatives" subtitle="What was set aside, and why. Discovery won't bring these back.">
      <AsyncView state={state} loadingLabel="Loading rejected alternatives">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState compact title="Nothing set aside" description="Opportunities you set aside, or that steering excludes, appear here with the reason." />
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: tokens.space.md }}>
              {rows.map((r) => (
                <li key={r.id} style={{ display: "grid", gap: 2 }}>
                  <span style={{ display: "flex", justifyContent: "space-between", gap: tokens.space.md }}>
                    <Link href={`/opportunities/${r.id}`} className="oos-link" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {r.supply_title}
                    </Link>
                    <span style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle, whiteSpace: "nowrap" }}>score {formatScore(r.overall_score)}</span>
                  </span>
                  <span style={{ fontSize: tokens.fontSize.sm, color: tokens.color.ink }}>{r.rejection_reason ?? "No reason recorded"}</span>
                  {r.rejected_at && <span style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>{formatDateTime(r.rejected_at)}</span>}
                </li>
              ))}
            </ul>
          )
        }
      </AsyncView>
    </Card>
  );
}

export interface SetAsideFormProps {
  opportunityId: string;
  label: string;
  onDone: () => void;
  onCancel: () => void;
}

/** Inline "why are you setting this aside?" — a reason is required; it's what the timeline and collaborators see. */
export function SetAsideForm({ opportunityId, label, onDone, onCancel }: SetAsideFormProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.rejectOpportunity(opportunityId, reason.trim());
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set this opportunity aside.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ padding: tokens.space.md, borderBottom: `1px solid ${tokens.color.border}`, display: "grid", gap: tokens.space.sm }}>
      <Field label={`Set aside “${label}”`} htmlFor="set-aside-reason">
        <Input id="set-aside-reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason, e.g. seller has poor reviews" />
      </Field>
      <div style={{ display: "flex", gap: tokens.space.sm }}>
        <Button type="submit" variant="danger" size="sm" loading={busy} disabled={!reason.trim()}>
          Set aside
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <ErrorNote message={error} />
    </form>
  );
}
