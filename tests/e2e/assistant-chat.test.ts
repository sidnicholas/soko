import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { appendChatExchange, chatSpendTodayUsd, closeDb, listChatMessages } from "@opportunity-os/db";

/** ADR-048 against a live Postgres: exchanges are saved per subject, in order, with their cost. */
const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("assistant chat (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("saves question and reply together, keeps threads apart and sums the day's spend", async () => {
    const id = randomUUID();
    const before = await chatSpendTodayUsd();

    const first = await appendChatExchange({
      subjectType: "intel_candidate", subjectId: id, authorId: randomUUID(), question: "Who is the buyer?", provider: "perplexity", model: "sonar-pro",
      reply: { content: "Acme Ltd", citations: [{ url: "https://acme.example", title: "Acme" }], inputTokens: 900, outputTokens: 40, usd: 0.0123 },
    });
    expect(first.question).toMatchObject({ role: "user", content: "Who is the buyer?", provider: null });
    expect(first.answer).toMatchObject({ role: "assistant", provider: "perplexity", content: "Acme Ltd", cost_usd: 0.0123, citations: [{ url: "https://acme.example", title: "Acme" }] });

    await appendChatExchange({ subjectType: "intel_candidate", subjectId: id, authorId: null, question: "And margin?", provider: "claude", model: "claude-sonnet-5-5", reply: { error: "timeout" } });
    // Same id, other subject type: a separate thread.
    await appendChatExchange({ subjectType: "opportunity", subjectId: id, authorId: null, question: "Other", provider: "openai", model: "gpt-5", reply: { content: "x", citations: [], inputTokens: 1, outputTokens: 1, usd: 0.001 } });

    const thread = await listChatMessages("intel_candidate", id);
    expect(thread.map((m) => [m.role, m.content, m.error])).toEqual([
      ["user", "Who is the buyer?", null],
      ["assistant", "Acme Ltd", null],
      ["user", "And margin?", null],
      ["assistant", "", "timeout"],
    ]);
    expect(await listChatMessages("opportunity", id)).toHaveLength(2);
    expect(await chatSpendTodayUsd()).toBeCloseTo(before + 0.0133, 6);
  });
});
