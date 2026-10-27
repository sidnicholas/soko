import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "@opportunity-os/config";
import { anthropicUsd } from "./anthropic";
import { compatUsd, type TokenPrice } from "./openai-compat";

/**
 * Conversational models for the per-opportunity assistant (ADR-048). Unlike
 * the gateway's task classes, the person picks the model for each message,
 * and the whole conversation is sent: these take a message list, not one
 * prompt. Claude reasons and drafts, Perplexity and You.com search the web
 * and cite what they found, OpenAI gives a second opinion.
 */

export const CHAT_MODEL_IDS = ["claude", "perplexity", "youcom", "openai"] as const;
export type ChatModelId = (typeof CHAT_MODEL_IDS)[number];

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatCitation {
  url: string;
  title?: string;
}

export interface ChatReply {
  text: string;
  citations: ChatCitation[];
  inputTokens: number;
  outputTokens: number;
  usd: number;
  model: string;
}

export interface ChatModel {
  readonly id: ChatModelId;
  readonly label: string;
  /** What it is good for, shown next to the picker. */
  readonly purpose: string;
  readonly model: string;
  chat(req: { system: string; turns: ChatTurn[]; timeoutMs: number }): Promise<ChatReply>;
}

/** Claude through the official SDK, the whole conversation as alternating turns. */
export class ClaudeChatModel implements ChatModel {
  readonly id = "claude" as const;
  readonly label = "Claude";
  readonly purpose = "Reasoning, deal analysis and drafting";
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    apiKey: string,
    private readonly maxTokens = 4000,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  async chat(req: { system: string; turns: ChatTurn[]; timeoutMs: number }): Promise<ChatReply> {
    const response = await this.client.beta.messages.create(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system: req.system,
        messages: req.turns.map((t) => ({ role: t.role, content: t.content })),
        output_config: { effort: "medium" },
      },
      { timeout: req.timeoutMs },
    );
    if (response.stop_reason === "refusal") throw new Error(`${this.model} declined the request`);
    const text = response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { text, citations: [], inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, usd: anthropicUsd(response.model, response.usage), model: response.model };
  }
}

interface CompletionBody {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null } }[];
  /** `cost` is a number (OpenRouter) or Perplexity's breakdown with `total_cost`. */
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number | { total_cost?: number } };
  /** Perplexity: the URLs the answer cites, in [n] order. */
  citations?: string[];
  /** Perplexity: the pages it read, with titles. */
  search_results?: { url?: string; title?: string }[];
  /** You.com Inference Router: each web search the model ran, its results numbered as cited. */
  web_results?: { searches?: { results?: { citation?: number; url?: string; title?: string }[] }[]; extracts?: { citation?: number; url?: string; title?: string }[] };
}

export interface CompletionsChatOptions {
  id: "perplexity" | "openai" | "youcom";
  label: string;
  purpose: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  price: TokenPrice;
  /** Flat per-request fee in USD on top of tokens (Perplexity charges per search). */
  requestFeeUsd?: number;
  /** Fee per web search the model ran (You.com bills each search it makes). */
  perSearchFeeUsd?: number;
  maxTokens: number;
  /** OpenAI reasoning models take max_completion_tokens and reject max_tokens. */
  tokenField: "max_tokens" | "max_completion_tokens";
  extraBody?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

/** Billed cost: the host's own figure when it reports one, else tokens at the configured price plus any request fee. */
export function completionUsd(o: Pick<CompletionsChatOptions, "price" | "requestFeeUsd" | "perSearchFeeUsd">, usage: CompletionBody["usage"] = {}, searches = 0): number {
  const reported = typeof usage.cost === "number" ? usage.cost : usage.cost?.total_cost;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) return reported;
  return compatUsd(o.price, usage) + (o.requestFeeUsd ?? 0) + searches * (o.perSearchFeeUsd ?? 0);
}

/** The cited pages of a Perplexity reply, titled where it says what they were; empty for other hosts. */
export function completionCitations(body: CompletionBody): ChatCitation[] {
  if (body.web_results) {
    // You.com: citation numbers are shared across searches and extracts; list them in [n] order.
    const sources = [...(body.web_results.searches ?? []).flatMap((s) => s.results ?? []), ...(body.web_results.extracts ?? [])].filter((r) => r.url);
    sources.sort((a, b) => (a.citation ?? Number.MAX_SAFE_INTEGER) - (b.citation ?? Number.MAX_SAFE_INTEGER));
    const seen = new Set<string>();
    return sources.flatMap((r) => (seen.has(r.url!) ? [] : (seen.add(r.url!), [{ url: r.url!, ...(r.title ? { title: r.title } : {}) }])));
  }
  const titles = new Map((body.search_results ?? []).filter((r) => r.url).map((r) => [r.url!, r.title]));
  const urls = body.citations?.length ? body.citations : (body.search_results ?? []).map((r) => r.url).filter((u): u is string => Boolean(u));
  return [...new Set(urls)].map((url) => ({ url, ...(titles.get(url) ? { title: titles.get(url)! } : {}) }));
}

/** Any Chat Completions host: OpenAI itself, and Perplexity, which speaks the same protocol and adds citations. */
export class CompletionsChatModel implements ChatModel {
  readonly id: "perplexity" | "openai" | "youcom";
  readonly label: string;
  readonly purpose: string;
  readonly model: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: CompletionsChatOptions) {
    this.id = opts.id;
    this.label = opts.label;
    this.purpose = opts.purpose;
    this.model = opts.model;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  async chat(req: { system: string; turns: ChatTurn[]; timeoutMs: number }): Promise<ChatReply> {
    const res = await this.doFetch(`${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        ...(this.opts.extraBody ?? {}),
        model: this.opts.model,
        [this.opts.tokenField]: this.opts.maxTokens,
        messages: [{ role: "system", content: req.system }, ...req.turns],
      }),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    if (!res.ok) throw new Error(`${this.label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as CompletionBody;
    const message = body.choices?.[0]?.message;
    if (message?.refusal) throw new Error(`${this.model} declined the request`);
    return {
      text: message?.content ?? "",
      citations: completionCitations(body),
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
      usd: completionUsd(this.opts, body.usage, body.web_results?.searches?.length ?? 0),
      model: body.model ?? this.opts.model,
    };
  }
}

/** OpenAI models that reason: they take max_completion_tokens and reasoning_effort. */
function isOpenAiReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model);
}

/** The chat models whose keys are configured, in picker order. */
export function chatModelsFromConfig(): ChatModel[] {
  const cfg = getConfig();
  const models: ChatModel[] = [];
  if (cfg.llm.anthropicKey) models.push(new ClaudeChatModel(cfg.llm.anthropicReasoningModel, cfg.llm.anthropicKey));
  const chat = cfg.llm.chat;
  if (chat.perplexityKey) {
    models.push(
      new CompletionsChatModel({
        id: "perplexity",
        label: "Perplexity",
        purpose: "Live web research with sources",
        baseUrl: "https://api.perplexity.ai",
        apiKey: chat.perplexityKey,
        model: chat.perplexityModel,
        price: chat.perplexityPrice,
        requestFeeUsd: chat.perplexityRequestFeeUsd,
        maxTokens: 4000,
        tokenField: "max_tokens",
      }),
    );
  }
  if (chat.youKey) {
    models.push(
      new CompletionsChatModel({
        id: "youcom",
        label: "You.com",
        purpose: "Web research on You.com's index, with sources",
        baseUrl: "https://api.you.com/v1",
        apiKey: chat.youKey,
        model: chat.youModel,
        price: chat.youPrice,
        perSearchFeeUsd: chat.youSearchFeeUsd,
        // Reasoning tokens count against max_completion_tokens; leave room.
        maxTokens: 12000,
        tokenField: "max_completion_tokens",
        // The Inference Router runs You.com searches for the model and returns the sources it used.
        extraBody: { tools: [{ type: "web_search", count: 8 }] },
      }),
    );
  }
  if (cfg.llm.openaiKey) {
    const reasoning = isOpenAiReasoningModel(chat.openaiModel);
    models.push(
      new CompletionsChatModel({
        id: "openai",
        label: "OpenAI",
        purpose: "A second opinion",
        baseUrl: "https://api.openai.com/v1",
        apiKey: cfg.llm.openaiKey,
        model: chat.openaiModel,
        price: chat.openaiPrice,
        // Reasoning tokens count against the cap, so leave room for them.
        maxTokens: reasoning ? 16000 : 4000,
        tokenField: reasoning ? "max_completion_tokens" : "max_tokens",
        ...(reasoning ? { extraBody: { reasoning_effort: "low" } } : {}),
      }),
    );
  }
  return models;
}
