"use client";

import type { ReactNode } from "react";
import { Button, Card, Spinner, tokens } from "@opportunity-os/ui";
import type { AsyncState } from "../lib/useAsync";

interface AsyncViewProps<T> {
  state: AsyncState<T>;
  children: (data: T) => ReactNode;
  /** Loading indicator label. */
  loadingLabel?: string;
}

/** Standard loading / error / ready rendering for an {@link AsyncState}. */
export function AsyncView<T>({ state, children, loadingLabel = "Loading" }: AsyncViewProps<T>) {
  if (state.loading && state.data === null) {
    return (
      <Card>
        <div style={{ display: "flex", justifyContent: "center", padding: tokens.space.xl }}>
          <Spinner label={loadingLabel} />
        </div>
      </Card>
    );
  }
  if (state.error && state.data === null) {
    return (
      <Card>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: tokens.space.md, padding: tokens.space.xl, textAlign: "center" }}>
          <div style={{ fontWeight: 600, color: tokens.color.ink }}>Couldn&apos;t load this view</div>
          <div style={{ color: tokens.color.inkMuted, maxWidth: "48ch" }}>{state.error}</div>
          <Button variant="secondary" onClick={state.reload}>
            Try again
          </Button>
        </div>
      </Card>
    );
  }
  if (state.data === null) return null;
  return <>{children(state.data)}</>;
}
