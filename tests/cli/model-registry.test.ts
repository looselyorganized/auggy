import { describe, expect, test } from "bun:test";
import {
  describeEnginePricing,
  listModelRegistry,
  listStaticModels,
} from "../../src/cli/model-registry";

describe("model registry", () => {
  test("lists static model entries from pricing tables", async () => {
    const result = await listModelRegistry({ provider: "anthropic" });

    expect(result.warnings).toEqual([]);
    expect(result.models.map((model) => model.id)).toContain("claude-sonnet-4-6");
    expect(result.models.find((model) => model.id === "claude-sonnet-4-6")?.pricing).toMatchObject({
      inputUsdPerMtok: 3,
      outputUsdPerMtok: 15,
    });
  });

  test("refresh maps OpenRouter pricing from per-token to per-million-token rates", async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "anthropic/claude-opus-4.8",
              name: "Anthropic: Claude Opus 4.8",
              context_length: 1_000_000,
              pricing: {
                prompt: "0.000005",
                completion: "0.000025",
                input_cache_read: "0.0000005",
                input_cache_write: "0.00000625",
              },
              top_provider: { max_completion_tokens: 128_000 },
              supported_parameters: ["tools", "response_format"],
            },
          ],
        }),
      );

    const result = await listModelRegistry({
      provider: "openrouter",
      refresh: true,
      fetch: fetcher,
    });

    expect(result.warnings).toEqual([]);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      provider: "openrouter",
      id: "anthropic/claude-opus-4.8",
      displayName: "Anthropic: Claude Opus 4.8",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      tools: true,
      source: "provider",
      status: "live",
    });
    expect(result.models[0]?.pricing).toMatchObject({
      inputUsdPerMtok: 5,
      outputUsdPerMtok: 25,
      cacheReadUsdPerMtok: 0.5,
      cacheWriteUsdPerMtok: 6.25,
    });
  });

  test("refresh falls back to static models when the provider call fails", async () => {
    const fetcher = async () => new Response("nope", { status: 503 });

    const result = await listModelRegistry({
      provider: "openrouter",
      refresh: true,
      fetch: fetcher,
    });

    expect(result.warnings[0]).toContain("openrouter: HTTP 503");
    expect(result.models.length).toBe(listStaticModels("openrouter").length);
  });

  test("describes configured engine pricing status", () => {
    expect(
      describeEnginePricing({ provider: "anthropic", model: "claude-sonnet-4-6" }),
    ).toMatchObject({
      status: "known",
      message: "$3/$15 per Mtok",
    });

    expect(
      describeEnginePricing({
        provider: "anthropic",
        model: "claude-future-99",
        costOverride: { inputUsdPerMtok: 2, outputUsdPerMtok: 8 },
      }),
    ).toMatchObject({
      status: "override",
      message: "$2/$8 per Mtok",
    });

    expect(
      describeEnginePricing({ provider: "anthropic", model: "claude-future-99" }),
    ).toMatchObject({
      status: "unknown",
    });
  });
});
