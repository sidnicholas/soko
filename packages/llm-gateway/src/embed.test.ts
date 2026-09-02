import { describe, it, expect } from "vitest";
import { EchoEmbeddingModel, EmbeddingGateway, type EmbeddingModel } from "./embed";

describe("EmbeddingGateway", () => {
  it("echo is deterministic, batched, normalized, and reports dim", async () => {
    const gw = new EmbeddingGateway(new EchoEmbeddingModel(512));
    const a = await gw.embed(["abc def", "ghi jkl"]);
    const b = await gw.embed(["abc def", "ghi jkl"]);
    expect(a.vectors).toHaveLength(2);
    expect(a.vectors[0]).toHaveLength(512);
    expect(a.vectors[0]).toEqual(b.vectors[0]);
    expect(a.telemetry.model).toBe("echo");
  });

  it("falls back to echo when the primary provider throws (no key / offline)", async () => {
    const broken: EmbeddingModel = {
      id: "openai:x",
      dim: 512,
      async embed() {
        throw new Error("no api key");
      },
    };
    const gw = new EmbeddingGateway(broken, new EchoEmbeddingModel(512));
    const r = await gw.embed(["hello world"]);
    expect(r.vectors[0]).toHaveLength(512);
    expect(r.telemetry.model).toBe("echo");
  });
});
