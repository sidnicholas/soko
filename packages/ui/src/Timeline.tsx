import * as React from "react";
import { tokens, tonePalette, type Tone } from "./theme";

export interface TimelineItem {
  id: string;
  title: React.ReactNode;
  at?: React.ReactNode;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  tone?: Tone;
}

export interface TimelineProps {
  items: TimelineItem[];
}

/** Vertical activity timeline (mission activity, transaction/settlement history). */
export function Timeline({ items }: TimelineProps) {
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {items.map((item, index) => {
        const palette = tonePalette[item.tone ?? "neutral"];
        const last = index === items.length - 1;
        return (
          <li key={item.id} style={{ display: "flex", gap: tokens.space.md }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <span
                aria-hidden
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: palette.dot,
                  border: `2px solid ${tokens.color.surface}`,
                  boxShadow: `0 0 0 1px ${palette.border}`,
                  marginTop: 4,
                  flexShrink: 0,
                }}
              />
              {!last && <span aria-hidden style={{ width: 2, flex: 1, background: tokens.color.border, marginTop: 2 }} />}
            </div>
            <div style={{ paddingBottom: last ? 0 : tokens.space.lg, minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: tokens.space.md, alignItems: "baseline" }}>
                <span style={{ fontSize: tokens.fontSize.sm, fontWeight: tokens.weight.semibold, color: tokens.color.ink }}>
                  {item.title}
                </span>
                {item.at !== undefined && (
                  <span style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle, whiteSpace: "nowrap" }}>{item.at}</span>
                )}
              </div>
              {item.description !== undefined && (
                <p style={{ margin: `${tokens.space.xs}px 0 0`, fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted, lineHeight: 1.5 }}>
                  {item.description}
                </p>
              )}
              {item.meta !== undefined && (
                <div style={{ marginTop: tokens.space.xs, fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle, fontFamily: tokens.font.mono }}>
                  {item.meta}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
