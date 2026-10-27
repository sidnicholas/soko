# ADR-048: Opportunity assistant

- Status: Accepted
- Date: 2026-10-27
- Builds on ADR-035 (Action Queue), ADR-047 (follow-ups); outside PRD v2

## Context

The product owner asked for an AI chat inside each opportunity, drawing on
several models (Perplexity, Claude, OpenAI), to talk a deal through where its
facts already are. The LLM gateway routes fixed task classes to a provider
chain with one prompt per call; a conversation needs the person to pick the
model and the whole thread sent each time.

## Decision

- **Where.** "Ask AI about this deal" on Action Queue and Follow-ups cards
  (intel candidates) and on the marketplace opportunity page. One saved
  thread per subject (`chat_messages`, migration 0039). The panel loads only
  when opened.
- **Models, picked per message.** Claude (`ANTHROPIC_REASONING_MODEL`) for
  reasoning and drafting; Perplexity (`PERPLEXITY_MODEL`, default
  `sonar-pro`) for live web research, its citations kept on the reply;
  You.com's Inference Router (`YDC_API_KEY`, `YOUCOM_CHAT_MODEL`, default
  `kimi-k3`) with its `web_search` tool, sources from `web_results`, each
  search it runs charged at `YOUCOM_SEARCH_FEE_USD`;
  OpenAI (`OPENAI_CHAT_MODEL`, default `gpt-5`) as a second opinion. A model
  shows up only when its key is set. Implemented in
  `packages/llm-gateway/src/chat.ts` beside the gateway, not as task classes.
- **Context.** Every message carries the subject's record (candidate with
  lead, evidence and latest economics; or opportunity with its sides and
  match), ids dropped, cut to 16k characters, fenced as untrusted data
  (§13.3), plus the most recent answered exchanges (24 turns / 40k
  characters). Failed exchanges are saved with their error and left out of
  later context, so turns alternate.
- **Who.** New permission `assistant:chat`: operators and admins, never
  agents (every message spends). Opportunities also follow mission access.
- **Spend.** Each reply stores tokens and cost (the host's reported cost
  when given, else list price plus Perplexity's per-request fee). A daily cap
  across all conversations, `CHAT_DAILY_USD` (default $5, UTC day), refuses
  new messages with 429 once reached.
- **Limits.** The assistant cannot send, change records or contact anyone,
  and its prompt says so.

## Consequences

- Rollout: apply migration 0039 before deploying; set `PERPLEXITY_API_KEY`
  (and `OPENAI_API_KEY` if not already) on `api`.
- Not built yet: "ask all three" side by side; Claude's own web search tool;
  markdown rendering of replies (shown as plain text).
