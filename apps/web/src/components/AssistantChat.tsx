"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Textarea, tokens, tonePalette } from "@opportunity-os/ui";
import { api, ApiError, type ChatMessage, type ChatModelId, type ChatSubject, type ChatThread } from "../lib/api";

const usd = (n: number) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);

/** Suggested first questions, by what each model is for. */
const STARTERS: Record<ChatModelId, string[]> = {
  claude: ["Is this deal worth pursuing? What would you verify first?", "Draft a short first message to the other party."],
  perplexity: ["Find the company or person behind this and any public way to contact them.", "What do comparable items sell for right now?"],
  youcom: ["Who is behind this listing, and how can I reach them?", "Find recent buyers or sellers of this item and their prices."],
  openai: ["What could go wrong with this deal?", "Play devil's advocate on the economics."],
};

function Bubble({ m, label }: { m: ChatMessage; label: string }) {
  const [copied, setCopied] = useState(false);
  const mine = m.role === "user";
  return (
    <div style={{ alignSelf: mine ? "flex-end" : "stretch", maxWidth: mine ? "85%" : "100%" }}>
      <div
        style={{
          padding: tokens.space.sm,
          borderRadius: tokens.radius.md,
          background: mine ? tokens.color.accentSoft : tokens.color.surfaceMuted,
          border: `1px solid ${m.error ? tonePalette.danger.fg : tokens.color.border}`,
          fontSize: tokens.fontSize.sm,
          color: tokens.color.ink,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {m.error ? <span style={{ color: tonePalette.danger.fg }}>{label} failed: {m.error}</span> : m.content}
        {m.citations.length > 0 && (
          <ol style={{ margin: `${tokens.space.sm}px 0 0`, paddingLeft: tokens.space.lg, fontSize: tokens.fontSize.xs }}>
            {m.citations.map((c) => (
              <li key={c.url}>
                <a href={c.url} target="_blank" rel="noopener noreferrer nofollow" className="oos-link">
                  {c.title ?? c.url}
                </a>
              </li>
            ))}
          </ol>
        )}
      </div>
      {!mine && (
        <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", marginTop: 2, fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>
          <span>
            {label}
            {m.model ? ` · ${m.model}` : ""}
            {m.cost_usd > 0 ? ` · ${usd(m.cost_usd)}` : ""}
          </span>
          {!m.error && (
            <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(m.content).then(() => setCopied(true))}>
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ChatBody({ subject, id }: { subject: ChatSubject; id: string }) {
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [model, setModel] = useState<ChatModelId | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    api
      .chatThread(subject, id)
      .then((t) => {
        if (!live) return;
        setThread(t);
        // Continue with the model that answered last, else the first one configured.
        const last = [...t.messages].reverse().find((m) => m.provider)?.provider;
        setModel(t.models.find((m) => m.id === last)?.id ?? t.models[0]?.id ?? null);
      })
      .catch((err: unknown) => live && setLoadError(err instanceof ApiError || err instanceof Error ? err.message : "Could not load the conversation."));
    return () => {
      live = false;
    };
  }, [subject, id]);

  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [thread?.messages.length, pending]);

  if (loadError) return <div style={{ fontSize: tokens.fontSize.sm, color: tonePalette.danger.fg }}>{loadError}</div>;
  if (!thread) return <div style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkSubtle }}>Loading the conversation…</div>;
  if (thread.models.length === 0) {
    return (
      <div style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>
        No AI model is configured. Set ANTHROPIC_API_KEY, PERPLEXITY_API_KEY, YDC_API_KEY or OPENAI_API_KEY on the api service and redeploy it.
      </div>
    );
  }

  const labels = Object.fromEntries(thread.models.map((m) => [m.id, m.label])) as Record<string, string>;
  const current = thread.models.find((m) => m.id === model);
  const overBudget = thread.budget.spent_today_usd >= thread.budget.daily_usd;

  async function send(text: string) {
    const content = text.trim();
    if (!content || !model || pending) return;
    setPending(content);
    setError(null);
    setDraft("");
    try {
      const out = await api.askAssistant(subject, id, { model, content });
      setThread((t) =>
        t ? { ...t, messages: [...t.messages, out.question, out.answer], budget: { ...t.budget, spent_today_usd: t.budget.spent_today_usd + out.answer.cost_usd } } : t,
      );
    } catch (err) {
      setDraft(content);
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Sending failed.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="oos-stack" style={{ gap: tokens.space.md }}>
      <div style={{ display: "flex", gap: tokens.space.xs, flexWrap: "wrap", alignItems: "center" }} role="group" aria-label="Model">
        {thread.models.map((m) => (
          <Button key={m.id} size="sm" variant={m.id === model ? "primary" : "secondary"} aria-pressed={m.id === model} title={m.model} onClick={() => setModel(m.id)}>
            {m.label}
          </Button>
        ))}
        {current && <span style={{ fontSize: tokens.fontSize.xs, color: tokens.color.inkSubtle }}>{current.purpose}</span>}
      </div>

      {(thread.messages.length > 0 || pending) && (
        <div className="oos-stack" style={{ gap: tokens.space.sm, maxHeight: 520, overflowY: "auto", paddingRight: tokens.space.xs }}>
          {thread.messages.map((m) => (
            <Bubble key={m.id} m={m} label={m.provider ? (labels[m.provider] ?? m.provider) : "You"} />
          ))}
          {pending && (
            <>
              <Bubble m={{ id: "pending", role: "user", provider: null, model: null, content: pending, citations: [], input_tokens: 0, output_tokens: 0, cost_usd: 0, error: null, created_at: "" }} label="You" />
              <div style={{ fontSize: tokens.fontSize.sm, color: tokens.color.inkSubtle }}>{current?.label ?? "The model"} is thinking…</div>
            </>
          )}
          <div ref={end} />
        </div>
      )}

      {thread.messages.length === 0 && !pending && model && (
        <div style={{ display: "flex", gap: tokens.space.xs, flexWrap: "wrap" }}>
          {STARTERS[model].map((q) => (
            <Button key={q} size="sm" variant="ghost" onClick={() => setDraft(q)}>
              {q}
            </Button>
          ))}
        </div>
      )}

      <Textarea
        aria-label="Message"
        placeholder={`Ask ${current?.label ?? "the assistant"} about this opportunity. Ctrl+Enter sends.`}
        value={draft}
        disabled={Boolean(pending)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send(draft);
          }
        }}
      />
      <div style={{ display: "flex", gap: tokens.space.sm, alignItems: "center", flexWrap: "wrap" }}>
        <Button size="sm" variant="primary" loading={Boolean(pending)} disabled={!draft.trim() || overBudget} onClick={() => void send(draft)}>
          Send
        </Button>
        <span style={{ fontSize: tokens.fontSize.xs, color: overBudget ? tonePalette.danger.fg : tokens.color.inkSubtle }}>
          {overBudget ? "Today's assistant budget is used up; it resets at 00:00 UTC." : `Spent today ${usd(thread.budget.spent_today_usd)} of ${usd(thread.budget.daily_usd)}`} · The deal's record goes with every message.
        </span>
        {error && <span style={{ fontSize: tokens.fontSize.sm, color: tonePalette.danger.fg }}>{error}</span>}
      </div>
    </div>
  );
}

/**
 * The opportunity assistant (ADR-048): a saved conversation about one
 * candidate or opportunity, with Claude, Perplexity or OpenAI picked per
 * message. Loads only when opened, so a long queue does not fetch every thread.
 */
export function AssistantChat({ subject, id, defaultOpen = false }: { subject: ChatSubject; id: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={defaultOpen} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary style={{ cursor: "pointer", fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>Ask AI about this deal</summary>
      {open && (
        <div style={{ marginTop: tokens.space.sm }}>
          <ChatBody subject={subject} id={id} />
        </div>
      )}
    </details>
  );
}
