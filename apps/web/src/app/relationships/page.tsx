"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, DataTable, Input, PageHeader, Select, tokens, type Column } from "@opportunity-os/ui";
import { api, type PartyListItem, type PartyType } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { AsyncView } from "../../components/AsyncView";
import { ContactForm } from "../../components/Contacts";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

/** Contacts and organizations (PRD v2 FR-06, ADR-041). Opportunity OS is their system of record; Pipedrive holds copies. */
export default function RelationshipsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [type, setType] = useState<"" | PartyType>("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const list = useAsync(() => api.listParties({ status, type: type || undefined, q: query || undefined }), [status, type, query]);

  const columns: Column<PartyListItem>[] = [
    {
      key: "name",
      header: "Name",
      render: (p) => (
        <div>
          <div style={{ fontWeight: tokens.weight.medium }}>{p.display_name}</div>
          <div style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>
            {[p.role_title, p.organization_name ? `at ${p.organization_name}` : null, p.location].filter(Boolean).join(" · ")}
          </div>
        </div>
      ),
    },
    { key: "type", header: "Kind", render: (p) => <Badge tone={p.type === "organization" ? "accent" : "neutral"}>{p.type}</Badge> },
    { key: "channels", header: "Channels", align: "right", render: (p) => p.channel_count },
    { key: "memories", header: "Memories", align: "right", render: (p) => p.memory_count },
    { key: "activity", header: status === "archived" ? "Archived" : "Last activity", render: (p) => day(status === "archived" ? p.archived_at : p.last_activity_at) },
    ...(status === "archived" ? [{ key: "fresh", header: "Next freshness check", render: (p: PartyListItem) => day(p.freshness_due_at) }] : []),
  ];

  return (
    <div className="oos-stack" style={{ gap: tokens.space.lg }}>
      <PageHeader
        eyebrow="Act"
        title="Relationships"
        subtitle="People and organizations behind your deals: how to reach them, what they agreed to, and what you know about them. Untouched for 90 days, a contact is archived; archived contacts are re-checked monthly and deleted once their details have gone stale."
        actions={
          !adding && (
            <Button size="sm" onClick={() => setAdding(true)}>
              New contact
            </Button>
          )
        }
      />
      {adding && (
        <Card title="New contact">
          <ContactForm onCancel={() => setAdding(false)} onDone={(id) => router.push(`/relationships/${id}`)} />
        </Card>
      )}
      <Card>
        <form
          style={{ display: "flex", gap: tokens.space.sm, flexWrap: "wrap", alignItems: "center" }}
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q.trim());
          }}
        >
          <Input aria-label="Search by name, email or phone" placeholder="Search name, email, phone" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 220px" }} />
          <Select aria-label="Kind" value={type} onChange={(e) => setType(e.target.value as "" | PartyType)} style={{ flex: "0 1 160px" }}>
            <option value="">People and organizations</option>
            <option value="person">People</option>
            <option value="organization">Organizations</option>
          </Select>
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as "active" | "archived")} style={{ flex: "0 1 140px" }}>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </Select>
          <Button size="sm" variant="secondary" type="submit">
            Search
          </Button>
        </form>
      </Card>
      <AsyncView state={list} loadingLabel="Loading contacts">
        {(rows) => (
          <Card flush>
            <div style={{ overflowX: "auto" }}>
              <DataTable
                columns={columns}
                rows={rows}
                getRowKey={(p) => p.id}
                onRowClick={(p) => router.push(`/relationships/${p.id}`)}
                empty={
                  <div style={{ padding: tokens.space.lg, color: tokens.color.inkSubtle, fontSize: tokens.fontSize.sm }}>
                    {query ? "Nobody matches that search." : status === "archived" ? "No archived contacts." : "No contacts yet. Add one here, or from a deal in the Action Queue."}
                  </div>
                }
              />
            </div>
          </Card>
        )}
      </AsyncView>
    </div>
  );
}
