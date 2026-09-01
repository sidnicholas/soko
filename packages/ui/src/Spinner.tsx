import * as React from "react";
import { tokens } from "./theme";

export interface SpinnerProps {
  size?: number;
  label?: React.ReactNode;
}

/** Inline loading indicator; keyframes live in the app's globals.css (`oos-spin`). */
export function Spinner({ size = 18, label }: SpinnerProps) {
  return (
    <div role="status" style={{ display: "inline-flex", alignItems: "center", gap: tokens.space.sm, color: tokens.color.inkMuted }}>
      <span
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          border: "2px solid " + tokens.color.border,
          borderTopColor: tokens.color.accent,
          display: "inline-block",
          animation: "oos-spin 0.7s linear infinite",
        }}
      />
      {label !== undefined && <span style={{ fontSize: tokens.fontSize.sm }}>{label}</span>}
    </div>
  );
}
