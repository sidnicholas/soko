"use client";

import { useState, type ReactNode } from "react";
import { Button, tokens } from "@opportunity-os/ui";

function Label({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 2 }}>{children}</div>;
}

/** Suggested outreach wording with a Copy button (Action Queue and Follow-ups). */
export function SuggestedOutreach({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md, padding: tokens.space.md, background: tokens.color.surfaceMuted }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: tokens.space.xs }}>
        <Label>{title}</Label>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div style={{ fontSize: tokens.fontSize.sm, whiteSpace: "pre-wrap", color: tokens.color.ink }}>{text}</div>
    </div>
  );
}
