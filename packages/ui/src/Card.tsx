import * as React from "react";
import { tokens } from "./theme";

export interface CardProps {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  /** Removes inner body padding for tables/lists that manage their own. */
  flush?: boolean;
  style?: React.CSSProperties;
  className?: string;
}

export function Card({ title, subtitle, actions, children, flush, style, className }: CardProps) {
  const hasHeader = title !== undefined || actions !== undefined || subtitle !== undefined;
  return (
    <section
      className={className}
      style={{
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.lg,
        boxShadow: tokens.shadow.sm,
        overflow: "hidden",
        ...style,
      }}
    >
      {hasHeader && (
        <header
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: tokens.space.md,
            padding: `${tokens.space.md}px ${tokens.space.lg}px`,
            borderBottom: `1px solid ${tokens.color.border}`,
          }}
        >
          <div style={{ minWidth: 0 }}>
            {title !== undefined && (
              <h3
                style={{
                  margin: 0,
                  fontSize: tokens.fontSize.lg,
                  fontWeight: tokens.weight.semibold,
                  color: tokens.color.ink,
                }}
              >
                {title}
              </h3>
            )}
            {subtitle !== undefined && (
              <p style={{ margin: `${tokens.space.xs}px 0 0`, fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>
                {subtitle}
              </p>
            )}
          </div>
          {actions !== undefined && <div style={{ display: "flex", gap: tokens.space.sm, flexShrink: 0 }}>{actions}</div>}
        </header>
      )}
      <div style={{ padding: flush ? 0 : tokens.space.lg }}>{children}</div>
    </section>
  );
}
