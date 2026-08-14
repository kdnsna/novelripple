import { z } from "zod";

import { MockAIProvider } from "@/server/ai/mock-provider";
import { OpenAICompatibleProvider } from "@/server/ai/openai-compatible-provider";
import type { AIProvider, ModelConfig } from "@/server/ai/types";

const RuntimeConfigSchema = z
  .object({
    providerName: z.enum(["openai-compatible", "mock"]),
    model: z.string().trim().min(1),
    structuredOutputMode: z.enum([
      "json_schema",
      "json_object",
      "prompt_json",
    ]),
    maxTokens: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict();

export type ConfiguredAI = {
  providerName: "openai-compatible" | "mock";
  modelConfig: ModelConfig;
};

export function readConfiguredAI(): ConfiguredAI {
  const maxTokens = process.env.OPENAI_MAX_TOKENS
    ? Number(process.env.OPENAI_MAX_TOKENS)
    : undefined;
  const config = RuntimeConfigSchema.parse({
    providerName: process.env.AI_PROVIDER_NAME,
    model: process.env.OPENAI_MODEL,
    structuredOutputMode: process.env.OPENAI_STRUCTURED_OUTPUT_MODE,
    ...(Number.isFinite(maxTokens) && maxTokens! > 0
      ? { maxTokens }
      : {}),
  });
  return {
    providerName: config.providerName,
    modelConfig: {
      model: config.model,
      structuredOutputMode: config.structuredOutputMode,
      ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
    },
  };
}

export function createConfiguredAIProvider(
  config: ConfiguredAI,
  mockProvider?: MockAIProvider,
): AIProvider {
  if (config.providerName === "mock") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Mock AI 只能用于测试或本地验证");
    }
    if (!mockProvider) throw new Error("Mock AI 缺少确定性输出");
    return mockProvider;
  }

  return new OpenAICompatibleProvider({
    providerName: config.providerName,
    apiKey: process.env.OPENAI_API_KEY ?? "",
    ...(process.env.OPENAI_BASE_URL
      ? { baseURL: process.env.OPENAI_BASE_URL }
      : {}),
  });
}
