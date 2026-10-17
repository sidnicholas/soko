"use client";

import Link from "next/link";
import { Badge, Card, PageHeader, tokens } from "@opportunity-os/ui";
import { api, type InboxItem } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";
import { CLASS_TONE, MESSAGE_TONE } from "../../components/Outreach";
import { words } from "../../components/Contacts";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

function Section({ title, subtitle, items, empty }: { title: string; subtitle?: string; items: InboxItem[]; empty: string }) {
  return (
    <Card title={`${title} (${items.length})`} subtitle={subtitle}>
      {items.length === 0 ? (
        <div style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>{empty}</div>
      ) : (
        items.map((i) => (
          <div key={`${i.conversation_id}-${i.message_id ?? ""}`} style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap", padding: `${tokens.space.xs}px 0`, borderBottom: `1px solid ${tokens.color.border}`, fontSize: tokens.fontSize.sm }}>
            <Link className="oos-link" href={`/outreach/${i.conversation_id}`}>
              {i.subject}
            </Link>
            <Link className="oos-link" href={`/relationships/${i.party_id}`} style={{ color: tokens.color.inkMuted }}>
              {i.party_name}
            </Link>
            <span style={{ color: tokens.color.inkMuted }}>{i.their_address}</span>
            {i.classification ? <Badge tone={CLASS_TONE[i.classification]}>{words(i.classification)}</Badge> : i.message_id && <Badge tone={MESSAGE_TONE[i.status]}>{i.status}</Badge>}
            {i.error && <span style={{ color: "#b02525" }}>{words(i.error)}</span>}
            <span style={{ marginLeft: "auto", color: tokens.color.inkMuted, fontSize: tokens.fontSize.xs }}>{when(i.at)}</span>
          </div>
        ))
      )}
    </Card>
  );
}

export default function OutreachInboxPage() {
  const inbox = useAsync(() => api.outreachInbox(), []);
  const status = useAsync(() => api.outreachStatus(), []);
  const s = status.data;
  return (
    <div className="oos-stack" style={{ gap: tokens.space.lg }}>
      <PageHeader
        title="Outreach Inbox"
        subtitle={
          s ? (
            s.configured ? (
              <span>
                Sending from {s.address} · {s.sentLast24h}/{s.dailyCap} in the last 24 h · {s.window.start}:00–{s.window.end}:00 {s.window.timezone}
                {s.window.weekends ? "" : ", weekdays"} · {s.inWindow ? "sending now" : "outside sending hours (approved emails wait)"}
              </span>
            ) : (
              <span style={{ color: "#8a5a00" }}>Sending is not set up: add {s.missing.join(", ")} on the api and worker-lifecycle services.</span>
            )
          ) : undefined
        }
      />
      <AsyncView state={inbox} loadingLabel="Loading inbox">
        {(d) => (
          <div className="oos-stack" style={{ gap: tokens.space.lg }}>
            <Section title="Needs review" subtitle="Replies and opt-outs you have not read." items={d.needsReview} empty="No new replies." />
            <Section title="Drafts" subtitle="Waiting for your approval. Nothing is sent until you approve it." items={d.drafts} empty="No drafts. Write one from a contact's page." />
            <Section title="Exceptions" subtitle="Failed sends, sends that did not finish, bounces." items={d.exceptions} empty="None." />
            <Section title="Queued" subtitle="Approved; goes out within the sending hours and daily cap." items={d.queued} empty="Nothing queued." />
            <Section title="Awaiting response" items={d.awaiting} empty="No open conversations waiting on a reply." />
          </div>
        )}
      </AsyncView>
    </div>
  );
}
