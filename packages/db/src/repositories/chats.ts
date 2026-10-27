import { sql } from "kysely";
import { getDb } from "../pool";

/**
 * The opportunity assistant's conversations (migration 0039, ADR-048): one
 * thread per intel candidate or marketplace opportunity. A person's message
 * and the model's reply are written together, so a thread always alternates.
 */

export type ChatSubjectType = "intel_candidate" | "opportunity";

export interface ChatCitationRow {
  url: string;
  title?: string;
}

export interface ChatMessageRow {
  id: string;
  role: "user" | "assistant";
  provider: string | null;
  model: string | null;
  content: string;
  citations: ChatCitationRow[];
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error: string | null;
  author_id: string | null;
  created_at: string;
}

export interface ChatExchangeInput {
  subjectType: ChatSubjectType;
  subjectId: string;
  authorId: string | null;
  question: string;
  provider: string;
  model: string;
  /** The reply, or the error that stopped it (then content says it failed). */
  reply: { content: string; citations: ChatCitationRow[]; inputTokens: number; outputTokens: number; usd: number } | { error: string };
}

const COLUMNS = [
  "id",
  "role",
  "provider",
  "model",
  "content",
  "citations",
  "input_tokens",
  "output_tokens",
  sql<number>`cost_usd::float`.as("cost_usd"),
  "error",
  "author_id",
  sql<string>`created_at::text`.as("created_at"),
] as const;

function row(r: Omit<ChatMessageRow, "citations" | "role"> & { citations: unknown; role: string }): ChatMessageRow {
  return { ...r, role: r.role === "assistant" ? "assistant" : "user", citations: Array.isArray(r.citations) ? (r.citations as ChatCitationRow[]) : [] };
}

/** A subject's thread, oldest first. */
export async function listChatMessages(subjectType: ChatSubjectType, subjectId: string, limit = 200): Promise<ChatMessageRow[]> {
  const rows = await getDb()
    .selectFrom("chat_messages")
    .select(COLUMNS)
    .where("subject_type", "=", subjectType)
    .where("subject_id", "=", subjectId)
    .orderBy("created_at", "desc")
    .orderBy("role", "desc") // same timestamp: the reply after its question
    .limit(limit)
    .execute();
  return rows.reverse().map(row);
}

/** Writes a question and its reply (or failure) in one transaction; returns both. */
export async function appendChatExchange(input: ChatExchangeInput): Promise<{ question: ChatMessageRow; answer: ChatMessageRow }> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const asked = new Date();
      const question = await tx
        .insertInto("chat_messages")
        .values({ subject_type: input.subjectType, subject_id: input.subjectId, role: "user", content: input.question, author_id: input.authorId, created_at: asked.toISOString() })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      const r = input.reply;
      const failed = "error" in r;
      const answer = await tx
        .insertInto("chat_messages")
        .values({
          subject_type: input.subjectType,
          subject_id: input.subjectId,
          role: "assistant",
          provider: input.provider,
          model: input.model,
          content: failed ? "" : r.content,
          citations: JSON.stringify(failed ? [] : r.citations),
          input_tokens: failed ? 0 : r.inputTokens,
          output_tokens: failed ? 0 : r.outputTokens,
          cost_usd: failed ? 0 : r.usd.toFixed(6),
          error: failed ? r.error.slice(0, 1000) : null,
          author_id: null,
          // A millisecond later, so the reply always sorts after its question.
          created_at: new Date(asked.getTime() + 1).toISOString(),
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return { question: row(question), answer: row(answer) };
    });
}

/** What the assistant spent since the start of the current UTC day. */
export async function chatSpendTodayUsd(now = new Date()): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const r = await getDb()
    .selectFrom("chat_messages")
    .select(sql<number>`coalesce(sum(cost_usd), 0)::float`.as("usd"))
    .where("created_at", ">=", start)
    .executeTakeFirst();
  return Number(r?.usd ?? 0);
}
