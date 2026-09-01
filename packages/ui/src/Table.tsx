import * as React from "react";
import { tokens } from "./theme";
import { EmptyState } from "./EmptyState";

export type Align = "left" | "right" | "center";

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  render: (row: T, index: number) => React.ReactNode;
  align?: Align;
  width?: number | string;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  /** Shown in place of the body when `rows` is empty. */
  empty?: React.ReactNode;
}

const cellBase: React.CSSProperties = {
  padding: `${tokens.space.sm}px ${tokens.space.lg}px`,
  fontSize: tokens.fontSize.sm,
  borderBottom: `1px solid ${tokens.color.border}`,
  verticalAlign: "middle",
};

/** Declarative, type-safe table. Renders its own empty state (§UX: no blanks). */
export function DataTable<T>({ columns, rows, getRowKey, onRowClick, empty }: DataTableProps<T>) {
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState compact title="No records" description="Nothing matches the current view yet." />}</>;
  }
  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: tokens.font.sans }}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{
                  ...cellBase,
                  textAlign: col.align ?? "left",
                  width: col.width,
                  color: tokens.color.inkSubtle,
                  fontSize: tokens.fontSize.xs,
                  fontWeight: tokens.weight.semibold,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  background: tokens.color.surfaceMuted,
                  whiteSpace: "nowrap",
                }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={getRowKey(row, index)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? "oos-row--clickable" : undefined}
              style={{ cursor: onRowClick ? "pointer" : "default", color: tokens.color.ink }}
            >
              {columns.map((col) => (
                <td key={col.key} style={{ ...cellBase, textAlign: col.align ?? "left" }}>
                  {col.render(row, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Styled `<table>` primitive for bespoke markup that doesn't fit {@link DataTable}. */
export function Table({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: tokens.font.sans, fontSize: tokens.fontSize.sm, ...style }}>
        {children}
      </table>
    </div>
  );
}
