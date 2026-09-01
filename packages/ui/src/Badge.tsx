import * as React from "react";
import { tokens, tonePalette, type Tone } from "./theme";
import { statusTone, statusLabel, type KnownStatus } from "./status";

export interface BadgeProps {
  children?: React.ReactNode;
  /** Explicit tone; ignored when `status` is provided. */
  tone?: Tone;
  /** A domain status string — colored + labeled automatically. */
  status?: KnownStatus | string;
  /** Render a leading dot (default true when a status/tone implies state). */
  dot?: boolean;
  style?: React.CSSProperties;
}

/** Status pill. Pass `status` for a domain lifecycle value, or `tone`+children. */
export function Badge({ children, tone, status, dot = true, style }: BadgeProps) {
  const resolvedTone: Tone = tone ?? (status !== undefined ? statusTone(status) : "neutral");
  const palette = tonePalette[resolvedTone];
  const label = children ?? (status !== undefined ? statusLabel(String(status)) : null);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: tokens.space.xs,
        padding: `2px ${tokens.space.sm}px`,
        borderRadius: tokens.radius.pill,
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        fontSize: tokens.fontSize.xs,
        fontWeight: tokens.weight.medium,
        lineHeight: 1.5,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {dot && <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: palette.dot }} />}
      {label}
    </span>
  );
}
