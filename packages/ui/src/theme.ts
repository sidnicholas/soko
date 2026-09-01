/**
 * Design tokens for the Opportunity OS operator console.
 * Simple surface, powerful depth (§15.1): a calm, tinted-neutral palette with a
 * single blue accent. Never pure #000/#fff. Spacing on a 4px grid.
 */
export const tokens = {
  color: {
    canvas: "#f4f6f9",
    surface: "#ffffff",
    surfaceMuted: "#f1f3f7",
    border: "#e3e7ee",
    borderStrong: "#d1d7e0",
    ink: "#1b1f2a",
    inkMuted: "#586074",
    inkSubtle: "#8b93a4",
    accent: "#2f56d6",
    accentHover: "#2444b3",
    accentSoft: "#eef2fe",
    focusRing: "rgba(47, 86, 214, 0.35)",
    dangerBorder: "#e6b4b4",
  },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 40 },
  radius: { sm: 6, md: 10, lg: 14, pill: 999 },
  font: {
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    mono: '"SFMono-Regular", "JetBrains Mono", "Fira Code", ui-monospace, Menlo, Consolas, monospace',
  },
  fontSize: { xs: 12, sm: 13, md: 14, lg: 16, xl: 20, xxl: 28 },
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
  shadow: {
    sm: "0 1px 2px rgba(16, 24, 40, 0.06)",
    md: "0 4px 14px rgba(16, 24, 40, 0.08)",
  },
} as const;

/** Semantic tone used by badges, timeline dots, and stat cards. */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "progress" | "accent";

export const tonePalette: Record<Tone, { bg: string; fg: string; border: string; dot: string }> = {
  neutral: { bg: "#f1f3f7", fg: "#4a5264", border: "#dfe3ea", dot: "#8b93a4" },
  info: { bg: "#eaf1fe", fg: "#1f4bb8", border: "#c7d9fb", dot: "#3568de" },
  success: { bg: "#e8f6ee", fg: "#1a7a45", border: "#bfe6cf", dot: "#25a35c" },
  warning: { bg: "#fef4e6", fg: "#9a5b13", border: "#f6dcb0", dot: "#e08a1e" },
  danger: { bg: "#fdecec", fg: "#b02525", border: "#f4c4c4", dot: "#d83a3a" },
  progress: { bg: "#eef0fd", fg: "#4436c0", border: "#d3d5f7", dot: "#5b4ee0" },
  accent: { bg: "#eef2fe", fg: "#2444b3", border: "#c9d5fb", dot: "#2f56d6" },
};
