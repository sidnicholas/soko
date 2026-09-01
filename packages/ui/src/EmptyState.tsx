import * as React from "react";
import { tokens } from "./theme";

export interface EmptyStateProps {
  title: React.ReactNode;
  /** Guide the operator toward the next action — never just "nothing here". */
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** Compact variant for inline sections inside a card. */
  compact?: boolean;
}

export function EmptyState({ title, description, action, compact }: EmptyStateProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        gap: tokens.space.sm,
        padding: compact ? `${tokens.space.lg}px` : `${tokens.space.xxl}px ${tokens.space.lg}px`,
        color: tokens.color.inkMuted,
      }}
    >
      <div
        aria-hidden
        style={{
          width: 36,
          height: 36,
          borderRadius: tokens.radius.md,
          background: tokens.color.surfaceMuted,
          border: `1px solid ${tokens.color.border}`,
          marginBottom: tokens.space.xs,
        }}
      />
      <div style={{ fontSize: tokens.fontSize.md, fontWeight: tokens.weight.semibold, color: tokens.color.ink }}>{title}</div>
      {description !== undefined && (
        <p style={{ margin: 0, fontSize: tokens.fontSize.sm, maxWidth: "48ch", lineHeight: 1.5 }}>{description}</p>
      )}
      {action !== undefined && <div style={{ marginTop: tokens.space.sm }}>{action}</div>}
    </div>
  );
}
