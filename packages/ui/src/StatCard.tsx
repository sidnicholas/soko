import * as React from "react";
import { tokens, tonePalette, type Tone } from "./theme";

export interface StatCardProps {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** Accent stripe + value color; defaults to neutral ink. */
  tone?: Tone;
}

/** A single headline metric. Left tone stripe instead of a decorative gradient. */
export function StatCard({ label, value, hint, tone }: StatCardProps) {
  const palette = tone ? tonePalette[tone] : undefined;
  return (
    <div
      style={{
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.border}`,
        borderLeft: palette ? `3px solid ${palette.dot}` : `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.lg,
        padding: `${tokens.space.md}px ${tokens.space.lg}px`,
        boxShadow: tokens.shadow.sm,
        display: "flex",
        flexDirection: "column",
        gap: tokens.space.xs,
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontSize: tokens.fontSize.xs,
          fontWeight: tokens.weight.medium,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: tokens.color.inkSubtle,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: tokens.fontSize.xxl,
          fontWeight: tokens.weight.semibold,
          color: palette ? palette.fg : tokens.color.ink,
          lineHeight: 1.1,
        }}
      >
        {value}
      </span>
      {hint !== undefined && <span style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>{hint}</span>}
    </div>
  );
}
