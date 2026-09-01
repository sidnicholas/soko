import * as React from "react";
import { tokens } from "./theme";

export interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Small overline / breadcrumb text above the title. */
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
}

export function PageHeader({ title, subtitle, eyebrow, actions }: PageHeaderProps) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: tokens.space.lg,
        flexWrap: "wrap",
        marginBottom: tokens.space.xl,
      }}
    >
      <div style={{ minWidth: 0 }}>
        {eyebrow !== undefined && (
          <div
            style={{
              fontSize: tokens.fontSize.xs,
              fontWeight: tokens.weight.medium,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: tokens.color.inkSubtle,
              marginBottom: tokens.space.xs,
            }}
          >
            {eyebrow}
          </div>
        )}
        <h1 style={{ margin: 0, fontSize: tokens.fontSize.xxl, fontWeight: tokens.weight.semibold, color: tokens.color.ink, lineHeight: 1.15 }}>
          {title}
        </h1>
        {subtitle !== undefined && (
          <p style={{ margin: `${tokens.space.sm}px 0 0`, fontSize: tokens.fontSize.md, color: tokens.color.inkMuted, maxWidth: "68ch" }}>
            {subtitle}
          </p>
        )}
      </div>
      {actions !== undefined && <div style={{ display: "flex", gap: tokens.space.sm, flexShrink: 0 }}>{actions}</div>}
    </header>
  );
}
