import * as React from "react";
import { tokens } from "./theme";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const VARIANT: Record<ButtonVariant, React.CSSProperties> = {
  primary: { background: tokens.color.accent, color: "#ffffff", border: `1px solid ${tokens.color.accent}` },
  secondary: { background: tokens.color.surface, color: tokens.color.ink, border: `1px solid ${tokens.color.borderStrong}` },
  ghost: { background: "transparent", color: tokens.color.inkMuted, border: "1px solid transparent" },
  danger: { background: "#fff", color: "#b02525", border: `1px solid ${tokens.color.dangerBorder}` },
};

/**
 * The console's single button primitive. Base look is inline (SSR-safe); the web
 * app's globals.css enhances hover/focus/active on the `oos-btn` class so the
 * component stays framework-free and usable without any stylesheet.
 */
export function Button({ variant = "secondary", size = "md", loading, disabled, children, style, className, ...rest }: ButtonProps) {
  const pad = size === "sm" ? `${tokens.space.xs}px ${tokens.space.md}px` : `${tokens.space.sm}px ${tokens.space.lg}px`;
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={["oos-btn", `oos-btn--${variant}`, className].filter(Boolean).join(" ")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: tokens.space.sm,
        padding: pad,
        fontFamily: tokens.font.sans,
        fontSize: size === "sm" ? tokens.fontSize.sm : tokens.fontSize.md,
        fontWeight: tokens.weight.medium,
        lineHeight: 1.2,
        borderRadius: tokens.radius.md,
        cursor: disabled || loading ? "not-allowed" : "pointer",
        opacity: disabled || loading ? 0.6 : 1,
        transition: "background 120ms ease, border-color 120ms ease",
        whiteSpace: "nowrap",
        ...VARIANT[variant],
        ...style,
      }}
    >
      {loading && (
        <span
          aria-hidden
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            border: "2px solid currentColor",
            borderTopColor: "transparent",
            display: "inline-block",
            animation: "oos-spin 0.7s linear infinite",
          }}
        />
      )}
      {children}
    </button>
  );
}
