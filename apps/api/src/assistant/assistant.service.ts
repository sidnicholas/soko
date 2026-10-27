import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { getConfig } from "@opportunity-os/config";
import {
  appendChatExchange,
  chatSpendTodayUsd,
  getIntelCandidate,
  getOpportunity,
  getOpportunityDetails,
  listChatMessages,
  listEconomicsVersions,
  listEvidence,
  type ChatSubjectType,
} from "@opportunity-os/db";
import { chatModelsFromConfig, type ChatModel, type ChatModelId } from "@opportunity-os/llm-gateway";
import { historyTurns, systemPrompt } from "./context";

const TIMEOUT_MS = 120_000;

/**
 * The opportunity assistant (ADR-048): one conversation per candidate or
 * opportunity, the model picked per message, the record sent as context.
 * Spend counts against a daily cap across every conversation.
 */
@Injectable()
export class AssistantService {
  private models: ChatModel[] | undefined;

  /** Built on first use, so a missing key never stops the API from starting. */
  private available(): ChatModel[] {
    this.models ??= chatModelsFromConfig();
    return this.models;
  }

  modelList() {
    return this.available().map((m) => ({ id: m.id, label: m.label, purpose: m.purpose, model: m.model }));
  }

  /** The record a conversation is about, as the model sees it. Undefined when it does not exist. */
  async subject(type: ChatSubjectType, id: string): Promise<unknown> {
    if (type === "intel_candidate") {
      const c = await getIntelCandidate(id);
      if (!c) return undefined;
      const [leadEvidence, candidateEvidence, versions] = await Promise.all([listEvidence("intel_lead", c.lead_id), listEvidence("intel_candidate", c.id), listEconomicsVersions("intel_candidate", c.id)]);
      return { ...c, evidence: [...leadEvidence, ...candidateEvidence], latest_economics: versions[0] ?? null };
    }
    const o = await getOpportunity(id);
    if (!o) return undefined;
    const [details, versions] = await Promise.all([getOpportunityDetails(id), listEconomicsVersions("opportunity", id)]);
    return { ...o, details: details ?? null, latest_economics: versions[0] ?? null };
  }

  async thread(type: ChatSubjectType, id: string) {
    const cfg = getConfig().llm.chat;
    const [messages, spent] = await Promise.all([listChatMessages(type, id), chatSpendTodayUsd()]);
    return { models: this.modelList(), messages, budget: { daily_usd: cfg.dailyUsd, spent_today_usd: spent } };
  }

  async ask(type: ChatSubjectType, id: string, input: { model: ChatModelId; content: string }, authorId: string) {
    const model = this.available().find((m) => m.id === input.model);
    if (!model) throw new BadRequestException(`${input.model} is not configured: set its API key on the api service`);
    const record = await this.subject(type, id);
    if (record === undefined) throw new NotFoundException(`${type === "intel_candidate" ? "Candidate" : "Opportunity"} ${id} not found`);
    const cap = getConfig().llm.chat.dailyUsd;
    const spent = await chatSpendTodayUsd();
    if (spent >= cap) throw new HttpException(`The assistant's daily budget of $${cap.toFixed(2)} is used up (CHAT_DAILY_USD); it resets at 00:00 UTC.`, HttpStatus.TOO_MANY_REQUESTS);

    const turns = [...historyTurns(await listChatMessages(type, id)), { role: "user" as const, content: input.content }];
    let reply: Parameters<typeof appendChatExchange>[0]["reply"];
    let served = model.model;
    try {
      const out = await model.chat({ system: systemPrompt(model.id, { kind: type, record }), turns, timeoutMs: TIMEOUT_MS });
      served = out.model;
      reply = out.text.trim()
        ? { content: out.text.trim(), citations: out.citations, inputTokens: out.inputTokens, outputTokens: out.outputTokens, usd: out.usd }
        : { error: `${model.label} returned an empty reply` };
    } catch (err) {
      reply = { error: err instanceof Error ? err.message : String(err) };
    }
    return appendChatExchange({ subjectType: type, subjectId: id, authorId, question: input.content, provider: model.id, model: served, reply });
  }
}
