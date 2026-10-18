"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, PageHeader, tokens } from "@opportunity-os/ui";
import { api, type BriefCitation, type Briefing } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";

/** Daily brief (ADR-046): the last 24 hours, every line linked to its source. */

function Cite({ c }: { c: BriefCitation }) {
  const external = /^https?:\/\//.test(c.href);
  return external ? (
    <a className="oos-link" href={c.href} target="_blank" rel="noreferrer noopener">
      {c.label} ↗
    </a>
  ) : (
    <Link className="oos-link" href={c.href}>
      {c.label}
    </Link>
  );
}

function BriefView({ b }: { b: Briefing }) {
  return (
    <div className="oos-stack" style={{ gap: tokens.space.lg }}>
      <Card>
        <div style={{ fontSize: tokens.fontSize.lg, fontWeight: 600 }}>{b.headline}</div>
        <div style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkMuted, marginTop: tokens.space.xs }}>
          {new Date(b.period_start).toLocaleString()} – {new Date(b.period_end).toLocaleString()} · built {new Date(b.generated_at).toLocaleString()}
          {b.delivered_at ? ` · emailed ${new Date(b.delivered_at).toLocaleString()}` : b.delivery_error ? ` · email failed: ${b.delivery_error}` : ""}
        </div>
      </Card>
      {b.content.sections.map((s) => (
        <Card key={s.key} title={s.title} subtitle={s.summary}>
          {s.items.length === 0 ? (
            <div style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>Nothing to report.</div>
          ) : (
            s.items.map((i, k) => (
              <div key={k} style={{ padding: `${tokens.space.xs}px 0`, borderBottom: `1px solid ${tokens.color.border}`, fontSize: tokens.fontSize.sm }}>
                <div style={{ fontWeight: 500 }}>{i.text}</div>
                {i.detail && <div style={{ color: tokens.color.inkMuted }}>{i.detail}</div>}
                <div style={{ display: "flex", gap: tokens.space.md, flexWrap: "wrap", fontSize: tokens.fontSize.xs, marginTop: 2 }}>
                  {i.citations.map((c, j) => (
                    <Cite key={j} c={c} />
                  ))}
                </div>
              </div>
            ))
          )}
        </Card>
      ))}
    </div>
  );
}

export default function BriefPage() {
  const [date, setDate] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    setDate(new URLSearchParams(window.location.search).get("date"));
  }, []);
  const list = useAsync(() => api.briefings(), [nonce]);
  const brief = useAsync(() => (date ? api.briefing(date) : api.latestBriefing()), [date, nonce]);

  async function rebuild(email: boolean) {
    setBusy(true);
    setNote(null);
    try {
      const b = await api.generateBriefing(email);
      setDate(b.brief_date);
      setNonce((n) => n + 1);
      if (email) setNote(b.emailed ? "Emailed." : "Not emailed: set BRIEF_EMAIL_TO and the outreach mailbox, or check the error above.");
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not rebuild");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="oos-stack" style={{ gap: tokens.space.lg }}>
      <PageHeader
        title="Daily Brief"
        subtitle="What changed in the last 24 hours. Built each morning; every line links to its source."
        actions={
          <span style={{ display: "inline-flex", gap: tokens.space.sm }}>
            <Button size="sm" loading={busy} onClick={() => void rebuild(false)}>
              Rebuild now
            </Button>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => void rebuild(true)}>
              Rebuild and email
            </Button>
          </span>
        }
      />
      {note && <div style={{ fontSize: tokens.fontSize.sm }}>{note}</div>}
      {(list.data ?? []).length > 1 && (
        <div style={{ display: "flex", gap: tokens.space.sm, flexWrap: "wrap", fontSize: tokens.fontSize.sm }}>
          {(list.data ?? []).map((b) => (
            <button key={b.id} type="button" className="oos-link" style={{ background: "none", border: 0, padding: 0, cursor: "pointer", fontWeight: b.brief_date === (brief.data?.brief_date ?? "") ? 700 : 400 }} onClick={() => setDate(b.brief_date)}>
              {b.brief_date}
            </button>
          ))}
        </div>
      )}
      <AsyncView state={brief} loadingLabel="Loading brief">
        {(b) =>
          b ? (
            <BriefView b={b} />
          ) : (
            <Card>
              <div style={{ fontSize: tokens.fontSize.sm }}>
                No brief yet. The first is built after 7am; or click <Badge tone="neutral">Rebuild now</Badge>.
              </div>
            </Card>
          )
        }
      </AsyncView>
    </div>
  );
}
