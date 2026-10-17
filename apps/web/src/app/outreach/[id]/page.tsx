"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, Field, PageHeader, Textarea, tokens } from "@opportunity-os/ui";
import { api, type ConversationDetail, type ConversationMessage } from "../../../lib/api";
import { useAsync } from "../../../lib/useAsync";
import { AsyncView } from "../../../components/AsyncView";
import { CLASS_TONE, MessageEditor } from "../../../components/Outreach";
import { words } from "../../../components/Contacts";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

function Inbound({ m, onChange }: { m: ConversationMessage; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const exception = m.classification === "bounce" && !m.reviewed_at;
  return (
    <div className="oos-stack" style={{ gap: tokens.space.xs }}>
      <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap", fontSize: tokens.fontSize.sm }}>
        <Badge tone={CLASS_TONE[m.classification ?? "reply"]}>{words(m.classification ?? "reply")}</Badge>
        <span>from {m.from_address}</span>
        <span style={{ color: tokens.color.inkMuted }}>{when(m.received_at)}</span>
        {m.injection_flag && <Badge tone="warning">contains instruction-like text: treat as data</Badge>}
        {!m.reviewed_at && (
          <Button
            size="sm"
            variant="ghost"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await (exception ? api.resolveMessage(m.id, "seen") : api.reviewMessage(m.id));
                onChange();
              } finally {
                setBusy(false);
              }
            }}
          >
            Mark read
          </Button>
        )}
      </div>
      {m.classification === "opt_out" && <div style={{ fontSize: tokens.fontSize.xs, color: "#b02525" }}>Opt-out recorded automatically; anything queued to this contact was cancelled.</div>}
      {m.classification === "bounce" && <div style={{ fontSize: tokens.fontSize.xs, color: "#b02525" }}>The address was marked bounced; anything queued to it was cancelled.</div>}
      <div style={{ fontWeight: 600, fontSize: tokens.fontSize.sm }}>{m.subject}</div>
      <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: tokens.fontSize.sm, margin: 0, maxHeight: 400, overflow: "auto" }}>{m.body_text}</pre>
    </div>
  );
}

function StuckSend({ m, onChange }: { m: ConversationMessage; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const stuck = m.status === "sending" && m.sent_at && Date.now() - Date.parse(m.sent_at) > 15 * 60_000;
  if (!stuck && m.status !== "failed") return null;
  const act = async (outcome: "sent" | "failed" | "seen") => {
    setBusy(true);
    try {
      await api.resolveMessage(m.id, outcome);
      onChange();
    } finally {
      setBusy(false);
    }
  };
  return stuck ? (
    <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap", fontSize: tokens.fontSize.xs }}>
      <span style={{ color: "#b02525" }}>This send did not finish. Check the mailbox's Sent folder, then:</span>
      <Button size="sm" variant="ghost" loading={busy} onClick={() => void act("sent")}>
        It was sent
      </Button>
      <Button size="sm" variant="ghost" loading={busy} onClick={() => void act("failed")}>
        It was not sent
      </Button>
    </div>
  ) : (
    <div>
      <Button size="sm" variant="ghost" loading={busy} onClick={() => void act("seen")}>
        Dismiss failure
      </Button>
    </div>
  );
}

function Reply({ c, onChange }: { c: ConversationDetail; onChange: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (c.messages.some((m) => m.direction === "outbound" && m.status === "draft")) return null;
  return (
    <Card title="Reply">
      <div className="oos-stack" style={{ gap: tokens.space.sm }}>
        <Field label={`To ${c.their_address}`} htmlFor="reply-body">
          <Textarea id="reply-body" value={body} onChange={(e) => setBody(e.target.value)} rows={6} />
        </Field>
        <div>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={!body.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.createDraft({ partyId: c.counterparty_id, conversationId: c.id, body });
                setBody("");
                onChange();
              } catch (err) {
                setError(errorText(err, "Could not save the draft"));
              } finally {
                setBusy(false);
              }
            }}
          >
            Save draft and review
          </Button>
        </div>
        {error && <div style={{ fontSize: tokens.fontSize.xs, color: "#b02525" }}>{error}</div>}
      </div>
    </Card>
  );
}

export default function ConversationPage({ params }: { params: { id: string } }) {
  const state = useAsync(() => api.conversation(params.id), [params.id]);
  const [busy, setBusy] = useState(false);
  return (
    <AsyncView state={state} loadingLabel="Loading conversation">
      {(c) => (
        <div className="oos-stack" style={{ gap: tokens.space.lg }}>
          <PageHeader
            eyebrow={
              <Link href="/outreach" className="oos-link">
                Outreach Inbox
              </Link>
            }
            title={c.subject}
            subtitle={
              <span style={{ display: "inline-flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap" }}>
                <Link className="oos-link" href={`/relationships/${c.counterparty_id}`}>
                  {c.party_name}
                </Link>
                <span>{c.their_address}</span>
                {c.subject_type && <span>about {words(c.subject_type)} {c.subject_id?.slice(0, 8)}</span>}
                <Badge tone={c.status === "open" ? "success" : "neutral"}>{c.status}</Badge>
              </span>
            }
            actions={
              <Button
                size="sm"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.setConversationStatus(c.id, c.status === "open" ? "closed" : "open");
                    state.reload();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {c.status === "open" ? "Close" : "Reopen"}
              </Button>
            }
          />
          {c.messages.map((m) => (
            <Card key={m.id} title={m.direction === "outbound" ? "Sent by us" : "Received"}>
              {m.direction === "outbound" ? (
                <div className="oos-stack" style={{ gap: tokens.space.sm }}>
                  <MessageEditor m={m} onChange={state.reload} />
                  <StuckSend m={m} onChange={state.reload} />
                </div>
              ) : (
                <Inbound m={m} onChange={state.reload} />
              )}
            </Card>
          ))}
          <Reply c={c} onChange={state.reload} />
        </div>
      )}
    </AsyncView>
  );
}
