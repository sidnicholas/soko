import * as React from "react";
import { tokens } from "./theme";

const controlStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: `${tokens.space.sm}px ${tokens.space.md}px`,
  fontFamily: tokens.font.sans,
  fontSize: tokens.fontSize.md,
  color: tokens.color.ink,
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.borderStrong}`,
  borderRadius: tokens.radius.md,
  outline: "none",
};

export interface FieldProps {
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  required?: boolean;
  children: React.ReactNode;
}

/** Label + control + hint wrapper used across the mission form and settings. */
export function Field({ label, htmlFor, hint, required, children }: FieldProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: tokens.space.xs }}>
      <label htmlFor={htmlFor} style={{ fontSize: tokens.fontSize.sm, fontWeight: tokens.weight.medium, color: tokens.color.ink }}>
        {label}
        {required && <span style={{ color: "#d83a3a", marginLeft: 2 }}>*</span>}
      </label>
      {children}
      {hint !== undefined && <span style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>{hint}</span>}
    </div>
  );
}

export function Input({ style, className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={["oos-control", className].filter(Boolean).join(" ")} style={{ ...controlStyle, ...style }} />;
}

export function Textarea({ style, className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={["oos-control", className].filter(Boolean).join(" ")}
      style={{ ...controlStyle, resize: "vertical", minHeight: 90, lineHeight: 1.5, ...style }}
    />
  );
}

export function Select({ style, className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={["oos-control", className].filter(Boolean).join(" ")} style={{ ...controlStyle, appearance: "none", cursor: "pointer", ...style }}>
      {children}
    </select>
  );
}
