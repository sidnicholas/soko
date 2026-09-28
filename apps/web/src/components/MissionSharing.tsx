"use client";

import { useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, Field, Input, Select, tokens } from "@opportunity-os/ui";
import { api, type MissionAccess, type MissionShare } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { AsyncView } from "./AsyncView";

export interface MissionSharingProps {
  missionId: string;
  access: MissionAccess;
  /** Called after a grant/revoke so the page can refresh its timeline. */
  onChanged?: () => void;
}

/**
 * Phase 4 sharing: who else can see or edit this mission. Everyone with
 * access sees the list; only the owner can grant or revoke (enforced by the
 * API, mirrored here so the controls aren't offered to people who can't use them).
 */
export function MissionSharing({ missionId, access, onChanged }: MissionSharingProps) {
  const shares = useAsync<MissionShare[]>(() => api.listMissionShares(missionId), [missionId]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MissionShare["role"]>("viewer");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isOwner = access === "owner";

  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      shares.reload();
      onChanged?.();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update sharing.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function onShare(event: FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;
    if (await run("share", () => api.shareMission(missionId, email.trim(), role))) setEmail("");
  }

  return (
    <Card
      title="Sharing"
      subtitle={isOwner ? "Invite collaborators by their account email." : `You have ${access} access to this mission.`}
    >
      <div className="oos-stack" style={{ gap: tokens.space.md }}>
        <AsyncView state={shares} loadingLabel="Loading collaborators">
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState compact title="Not shared" description={isOwner ? "Only you can see this mission." : "No other collaborators."} />
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: tokens.space.sm }}>
                {rows.map((s) => (
                  <li key={s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: tokens.space.md }}>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: tokens.fontSize.sm, color: tokens.color.ink }}>{s.display_name}</span>
                      <span style={{ display: "block", fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle, wordBreak: "break-all" }}>{s.email}</span>
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: tokens.space.sm, flexShrink: 0 }}>
                      <Badge tone={s.role === "editor" ? "accent" : "neutral"}>{s.role}</Badge>
                      {isOwner && (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busy === s.user_id}
                          aria-label={`Remove ${s.email}`}
                          onClick={() => run(s.user_id, () => api.unshareMission(missionId, s.user_id))}
                        >
                          Remove
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
        </AsyncView>

        {isOwner && (
          <form onSubmit={onShare} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", gap: tokens.space.sm, alignItems: "end" }}>
            <Field label="Email" htmlFor="share-email">
              <Input id="share-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" />
            </Field>
            <Field label="Role" htmlFor="share-role">
              <Select id="share-role" value={role} onChange={(e) => setRole(e.target.value as MissionShare["role"])}>
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </Select>
            </Field>
            <Button type="submit" variant="primary" loading={busy === "share"} disabled={!email.trim()}>
              Share
            </Button>
          </form>
        )}

        {error && (
          <div role="alert" style={{ padding: tokens.space.sm, borderRadius: tokens.radius.md, background: "#fdecec", color: "#b02525", fontSize: tokens.fontSize.sm }}>
            {error}
          </div>
        )}
      </div>
    </Card>
  );
}
